package com.creeba.expo

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import org.json.JSONObject
import java.net.DatagramSocket
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

// iroh (uniffi) bindings — package published as `computer.iroh:iroh` (v1.0.0).
import computer.iroh.Connection
import computer.iroh.Endpoint
import computer.iroh.EndpointId
import computer.iroh.EndpointOptions
import computer.iroh.EndpointTicket
import computer.iroh.IrohAndroid
import computer.iroh.RecvStream
import computer.iroh.SecretKey
import computer.iroh.SendStream

/**
 * iroh node + mDNS discovery (port of `iroh-mdns.ts`), desktop interop:
 * ALPN `creeba/chat/0`, length-prefixed frames (4-byte big-endian + JSON),
 * mDNS service `_creebachat._udp` with TXT {id,userId,name,room,ticket}.
 */
class IrohNode(
  private val context: Context?,
  private val emit: (String, Map<String, Any?>) -> Unit,
) {
  private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
  private val mutex = Mutex()

  private var endpoint: Endpoint? = null
  private var userId = ""
  private var name = ""
  private var room: String? = null
  private var ticket = ""
  private var publicKey = ""
  @Volatile private var destroyed = false

  private data class PeerConn(val conn: Connection, val send: SendStream, val recv: RecvStream)
  private val connections = ConcurrentHashMap<String, PeerConn>()
  private val dialing = ConcurrentHashMap.newKeySet<String>()

  private val nsdManager: NsdManager? by lazy {
    context?.getSystemService(Context.NSD_SERVICE) as? NsdManager
  }
  private var registration: NsdManager.RegistrationListener? = null
  private var discovery: NsdManager.DiscoveryListener? = null
  private var multicastLock: WifiManager.MulticastLock? = null
  private var servicePort = 49737
  private var socket: DatagramSocket? = null

  companion object {
    private val ALPN = "creeba/chat/0".toByteArray()
    private const val SERVICE_TYPE = "_creebachat._udp"
    private const val PREFS = "creeba-expo"
    private const val SECRET_KEY = "secretKey"
  }

  // MARK: lifecycle

  suspend fun start(identityJson: String): String {
    JSONObject(identityJson).let {
      userId = it.optString("userId")
      name = it.optString("name")
    }

    // iroh needs the Android context (DNS resolver via LinkProperties/JNI)
    // before any Endpoint.bind. Idempotent call.
    context?.applicationContext?.let { IrohAndroid.installAndroidContext(it) }

    // secretKey null on first launch → iroh generates one (persisted afterwards).
    val options = EndpointOptions(
      secretKey = loadSecretKey(),
      alpns = listOf(ALPN),
    )
    val ep = Endpoint.bind(options)
    endpoint = ep
    saveSecretKey(ep.secretKey())
    publicKey = hex(ep.id())
    refreshTicket()

    scope.launch { acceptLoop() }
    return publicKey
  }

  fun setIdentity(identityJson: String) {
    JSONObject(identityJson).let {
      userId = it.optString("userId")
      name = it.optString("name")
    }
    if (room != null) publish()
  }

  fun join(room: String) {
    this.room = room
    acquireMulticastLock()
    publish()
    discover()
  }

  fun send(peerId: String, frameJson: String) {
    val pc = connections[peerId] ?: return
    scope.launch { write(pc, frameJson) }
  }

  fun broadcast(frameJson: String) {
    scope.launch {
      for (pc in connections.values) write(pc, frameJson)
    }
  }

  fun destroy() {
    destroyed = true
    runCatching { registration?.let { nsdManager?.unregisterService(it) } }
    runCatching { discovery?.let { nsdManager?.stopServiceDiscovery(it) } }
    runCatching { multicastLock?.release() }
    runCatching { socket?.close() }
    for (pc in connections.values) runCatching { pc.conn.close(0L, "bye".toByteArray()) }
    connections.clear()
    scope.launch {
      runCatching { endpoint?.shutdown() }
      endpoint = null
    }
  }

  // MARK: iroh

  private fun refreshTicket() {
    val ep = endpoint ?: return
    runCatching { ticket = EndpointTicket.fromAddr(ep.addr()).toString() }
      .onFailure { emitError("refreshTicket: ${it.message}") }
  }

  private suspend fun acceptLoop() {
    val ep = endpoint ?: return
    while (!destroyed) {
      try {
        val incoming = ep.acceptNext() ?: return
        val conn = incoming.accept().connect()
        attach(conn, isDialer = false)
      } catch (e: Throwable) {
        if (destroyed) return
        emitError("acceptLoop: ${e.message}")
      }
    }
  }

  private suspend fun dial(ticketStr: String) {
    val ep = endpoint ?: return
    try {
      val addr = EndpointTicket.fromString(ticketStr).endpointAddr()
      val conn = ep.connect(addr, ALPN)
      attach(conn, isDialer = true)
    } catch (e: Throwable) {
      emitError("dial: ${e.message}")
    }
  }

  private suspend fun attach(conn: Connection, isDialer: Boolean) {
    val peerId = hex(conn.remoteId())
    dialing.remove(peerId)

    if (connections.containsKey(peerId) || peerId == publicKey) {
      runCatching { conn.close(0L, "dup".toByteArray()) }
      return
    }

    try {
      val bi = if (isDialer) conn.openBi() else conn.acceptBi()
      val pc = PeerConn(conn, bi.send(), bi.recv())
      connections[peerId] = pc
      emit("onPeerOpen", mapOf("peerId" to peerId))
      scope.launch { readLoop(peerId, pc.recv) }
    } catch (e: Throwable) {
      emitError("attach: ${e.message}")
    }
  }

  private fun removePeer(peerId: String) {
    if (connections.remove(peerId) != null) {
      emit("onPeerClose", mapOf("peerId" to peerId))
    }
  }

  private suspend fun write(pc: PeerConn, frameJson: String) {
    val body = frameJson.toByteArray()
    val out = ByteArray(4 + body.size)
    out[0] = (body.size ushr 24).toByte()
    out[1] = (body.size ushr 16).toByte()
    out[2] = (body.size ushr 8).toByte()
    out[3] = body.size.toByte()
    System.arraycopy(body, 0, out, 4, body.size)
    // writeAll is serialized per stream; guard the write order.
    mutex.withLock {
      runCatching { pc.send.writeAll(out) }
        .onFailure { emitError("write: ${it.message}") }
    }
  }

  private suspend fun readLoop(peerId: String, recv: RecvStream) {
    var buffer = ByteArray(0)
    while (!destroyed) {
      val chunk: ByteArray = try {
        recv.read(65536u)
      } catch (e: Throwable) {
        break // stream closed
      }
      if (chunk.isEmpty()) break
      buffer += chunk
      while (buffer.size >= 4) {
        val len = ((buffer[0].toInt() and 0xff) shl 24) or
          ((buffer[1].toInt() and 0xff) shl 16) or
          ((buffer[2].toInt() and 0xff) shl 8) or
          (buffer[3].toInt() and 0xff)
        if (buffer.size < 4 + len) break
        val frame = buffer.copyOfRange(4, 4 + len)
        buffer = buffer.copyOfRange(4 + len, buffer.size)
        emit("onFrame", mapOf("peerId" to peerId, "frame" to String(frame, Charsets.UTF_8)))
      }
    }
    removePeer(peerId)
  }

  // MARK: mDNS (NsdManager)

  private fun serviceName() = "creeba-" + publicKey.take(16)

  private fun acquireMulticastLock() {
    if (multicastLock != null) return
    val wifi = context?.getSystemService(Context.WIFI_SERVICE) as? WifiManager ?: return
    multicastLock = wifi.createMulticastLock("creeba-expo").apply {
      setReferenceCounted(true)
      acquire()
    }
  }

  private fun publish() {
    val room = room ?: return
    if (ticket.isEmpty()) return
    val nsd = nsdManager ?: return

    // Real port required by NsdManager (data goes through iroh, not this socket).
    if (socket == null) socket = DatagramSocket(0).also { servicePort = it.localPort }

    registration?.let { runCatching { nsd.unregisterService(it) } }

    val info = NsdServiceInfo().apply {
      serviceName = serviceName()
      serviceType = SERVICE_TYPE
      port = servicePort
      setAttribute("id", publicKey)
      setAttribute("userId", userId)
      setAttribute("name", name)
      setAttribute("room", room)
      setAttribute("ticket", ticket)
    }
    val listener = object : NsdManager.RegistrationListener {
      override fun onServiceRegistered(info: NsdServiceInfo) {}
      override fun onRegistrationFailed(info: NsdServiceInfo, code: Int) {
        emitError("mDNS register failed: $code")
      }
      override fun onServiceUnregistered(info: NsdServiceInfo) {}
      override fun onUnregistrationFailed(info: NsdServiceInfo, code: Int) {}
    }
    registration = listener
    runCatching { nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, listener) }
  }

  private fun discover() {
    if (discovery != null) return
    val nsd = nsdManager ?: return

    val listener = object : NsdManager.DiscoveryListener {
      override fun onDiscoveryStarted(type: String) {}
      override fun onDiscoveryStopped(type: String) {}
      override fun onStartDiscoveryFailed(type: String, code: Int) { emitError("mDNS discovery failed: $code") }
      override fun onStopDiscoveryFailed(type: String, code: Int) {}
      override fun onServiceLost(info: NsdServiceInfo) {}
      override fun onServiceFound(info: NsdServiceInfo) {
        // Resolve to obtain the TXT attributes.
        nsd.resolveService(info, object : NsdManager.ResolveListener {
          override fun onResolveFailed(info: NsdServiceInfo, code: Int) {}
          override fun onServiceResolved(info: NsdServiceInfo) {
            val attrs = info.attributes ?: return
            val id = attrs["id"]?.let { String(it) } ?: return
            val tkt = attrs["ticket"]?.let { String(it) } ?: return
            val r = attrs["room"]?.let { String(it) }
            onDiscovered(id, tkt, r)
          }
        })
      }
    }
    discovery = listener
    runCatching { nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener) }
  }

  private fun onDiscovered(id: String, ticketStr: String, discoveredRoom: String?) {
    if (discoveredRoom != room || id == publicKey) return
    if (connections.containsKey(id) || dialing.contains(id)) return
    // Tie-break: only the lower node-id dials.
    if (publicKey < id) {
      dialing.add(id)
      scope.launch { dial(ticketStr) }
    }
  }

  // MARK: helpers

  private fun emitError(message: String?) {
    emit("onError", mapOf("message" to (message ?: "unknown")))
  }

  private fun hex(id: EndpointId): String =
    id.toBytes().joinToString("") { "%02x".format(it.toInt() and 0xff) }

  private fun loadSecretKey(): ByteArray? {
    val prefs = context?.getSharedPreferences(PREFS, Context.MODE_PRIVATE) ?: return null
    val b64 = prefs.getString(SECRET_KEY, null) ?: return null
    return runCatching {
      android.util.Base64.decode(b64, android.util.Base64.NO_WRAP)
    }.getOrNull()
  }

  private fun saveSecretKey(key: SecretKey) {
    val prefs = context?.getSharedPreferences(PREFS, Context.MODE_PRIVATE) ?: return
    val b64 = android.util.Base64.encodeToString(key.toBytes(), android.util.Base64.NO_WRAP)
    prefs.edit().putString(SECRET_KEY, b64).apply()
  }
}
