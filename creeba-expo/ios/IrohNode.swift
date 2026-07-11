import Foundation
import Network
import IrohLib // Swift Package iroh-ffi (produces `IrohLib`) — integrated via cocoapods-spm.

/**
 * iroh node + mDNS discovery (port of the desktop `iroh-mdns.ts`).
 *
 * Wire format identical to desktop → direct interop:
 *   - ALPN `creeba/chat/0`
 *   - length-prefixed NDJSON frames (4-byte big-endian length + JSON body)
 *   - mDNS service `_creebachat._udp` with TXT {id,userId,name,room,ticket}
 *
 * iroh-ffi 1.0 API: `Endpoint.bind(options:)`, `EndpointId`/`SecretKey`,
 * `EndpointTicket.fromAddr/fromString`, streams `RecvStream.read`/`SendStream.writeAll`.
 */
actor IrohNode {
  // Emits events to JS (name, body). Provided by the module.
  private let emit: @Sendable (String, [String: Any]) -> Void

  private var endpoint: Endpoint?
  private var identity = Identity(userId: "", name: "")
  private var room: String?
  private var ticket = ""
  private var publicKey = ""
  private var destroyed = false

  private struct PeerConn {
    let conn: Connection
    let send: SendStream
    let recv: RecvStream
  }
  private var connections: [String: PeerConn] = [:]
  private var dialing: Set<String> = []

  // mDNS (Network.framework)
  private var listener: NWListener?
  private var browser: NWBrowser?
  private let mdnsQueue = DispatchQueue(label: "chat.creeba.mdns")

  private static let alpn = Data("creeba/chat/0".utf8)
  private static let serviceType = "_creebachat._udp"
  private static let secretKeyDefaultsKey = "creeba.iroh.secretKey"

  init(emit: @escaping @Sendable (String, [String: Any]) -> Void) {
    self.emit = emit
  }

  struct Identity: Codable { var userId: String; var name: String }

  // MARK: - Lifecycle

  func start(identityJson: String) async throws -> String {
    if let data = identityJson.data(using: .utf8),
      let id = try? JSONDecoder().decode(Identity.self, from: data) {
      identity = id
    }

    // Persisted secret key (32 bytes) → stable node-id across launches.
    let options = EndpointOptions(
      secretKey: Self.loadSecretKeyData(),
      alpns: [Self.alpn]
    )
    let ep = try await Endpoint.bind(options: options)
    endpoint = ep
    Self.saveSecretKey(ep.secretKey())
    publicKey = Self.hex(ep.id())
    refreshTicket()

    Task { await self.acceptLoop() }
    return publicKey
  }

  func setIdentity(_ identityJson: String) {
    if let data = identityJson.data(using: .utf8),
      let id = try? JSONDecoder().decode(Identity.self, from: data) {
      identity = id
      if room != nil { publish() }
    }
  }

  func join(room: String) {
    self.room = room
    publish()
    discover()
  }

  func send(peerId: String, frameJson: String) async {
    guard let pc = connections[peerId] else { return }
    await write(pc, frameJson: frameJson)
  }

  func broadcast(frameJson: String) async {
    for (_, pc) in connections {
      await write(pc, frameJson: frameJson)
    }
  }

  func destroy() async {
    destroyed = true
    listener?.cancel(); listener = nil
    browser?.cancel(); browser = nil
    for (_, pc) in connections {
      try? pc.conn.close(errorCode: 0, reason: Data("bye".utf8))
    }
    connections.removeAll()
    try? await endpoint?.close()
    endpoint = nil
  }

  // MARK: - iroh

  private func refreshTicket() {
    guard let ep = endpoint else { return }
    do {
      let t = try EndpointTicket.fromAddr(addr: ep.addr())
      ticket = t.description
    } catch {
      emitError("refreshTicket: \(error)")
    }
  }

  private func acceptLoop() async {
    guard let ep = endpoint else { return }
    while !destroyed {
      guard let incoming = await ep.acceptNext() else { return }
      do {
        let accepting = try await incoming.accept()
        let conn = try await accepting.connect()
        await attach(conn: conn, isDialer: false)
      } catch {
        if destroyed { return }
        emitError("acceptLoop: \(error)")
      }
    }
  }

  private func dial(ticketStr: String) async {
    guard let ep = endpoint else { return }
    do {
      let addr = try EndpointTicket.fromString(str: ticketStr).endpointAddr()
      let conn = try await ep.connect(addr: addr, alpn: Self.alpn)
      await attach(conn: conn, isDialer: true)
    } catch {
      emitError("dial: \(error)")
    }
  }

  private func attach(conn: Connection, isDialer: Bool) async {
    let peerId = Self.hex(conn.remoteId())
    dialing.remove(peerId)

    if connections[peerId] != nil || peerId == publicKey {
      try? conn.close(errorCode: 0, reason: Data("dup".utf8))
      return
    }

    do {
      let bi = isDialer ? try await conn.openBi() : try await conn.acceptBi()
      let pc = PeerConn(conn: conn, send: bi.send(), recv: bi.recv())
      connections[peerId] = pc
      emit("onPeerOpen", ["peerId": peerId])
      Task { await self.readLoop(peerId: peerId, recv: pc.recv) }
    } catch {
      emitError("attach: \(error)")
    }
  }

  private func removePeer(_ peerId: String) {
    if connections.removeValue(forKey: peerId) != nil {
      emit("onPeerClose", ["peerId": peerId])
    }
  }

  private func write(_ pc: PeerConn, frameJson: String) async {
    let body = Data(frameJson.utf8)
    var out = Data()
    var len = UInt32(body.count).bigEndian
    withUnsafeBytes(of: &len) { out.append(contentsOf: $0) }
    out.append(body)
    do {
      try await pc.send.writeAll(buf: out)
    } catch {
      emitError("write: \(error)")
    }
  }

  private func readLoop(peerId: String, recv: RecvStream) async {
    var buffer = [UInt8]()
    while !destroyed {
      let chunk: Data
      do {
        chunk = try await recv.read(sizeLimit: 65536)
      } catch {
        break // stream closed
      }
      if chunk.isEmpty { break }
      buffer.append(contentsOf: chunk)
      while buffer.count >= 4 {
        let len =
          (Int(buffer[0]) << 24) | (Int(buffer[1]) << 16)
          | (Int(buffer[2]) << 8) | Int(buffer[3])
        if buffer.count < 4 + len { break }
        let frameBytes = buffer[4..<(4 + len)]
        buffer.removeFirst(4 + len)
        if let str = String(bytes: frameBytes, encoding: .utf8) {
          emit("onFrame", ["peerId": peerId, "frame": str])
        }
      }
    }
    removePeer(peerId)
  }

  // MARK: - mDNS

  private func serviceName() -> String {
    "creeba-" + String(publicKey.prefix(16))
  }

  private func publish() {
    guard let room = room, !ticket.isEmpty else { return }
    listener?.cancel()
    do {
      let listener = try NWListener(using: .udp)
      var txt = NWTXTRecord()
      txt["id"] = publicKey
      txt["userId"] = identity.userId
      txt["name"] = identity.name
      txt["room"] = room
      txt["ticket"] = ticket
      listener.service = NWListener.Service(
        name: serviceName(), type: Self.serviceType, domain: nil, txtRecord: txt
      )
      listener.newConnectionHandler = { $0.cancel() } // unused socket
      listener.start(queue: mdnsQueue)
      self.listener = listener
    } catch {
      emitError("publish: \(error)")
    }
  }

  private func discover() {
    guard browser == nil else { return }
    let browser = NWBrowser(
      for: .bonjourWithTXTRecord(type: Self.serviceType, domain: nil), using: .udp
    )
    browser.browseResultsChangedHandler = { [weak self] results, _ in
      for result in results {
        guard case let .bonjour(txt) = result.metadata else { continue }
        guard let id = txt["id"], let ticket = txt["ticket"] else { continue }
        let room = txt["room"]
        let name = txt["name"] ?? "?"
        Task { await self?.onDiscovered(id: id, ticket: ticket, room: room, name: name) }
      }
    }
    browser.start(queue: mdnsQueue)
    self.browser = browser
  }

  private func onDiscovered(id: String, ticket: String, room: String?, name: String) async {
    guard room == self.room, id != publicKey else { return }
    if connections[id] != nil || dialing.contains(id) { return }
    // Tie-break: only the lower node-id dials.
    if publicKey < id {
      dialing.insert(id)
      await dial(ticketStr: ticket)
    }
  }

  // MARK: - Helpers

  private func emitError(_ message: String) {
    emit("onError", ["message": message])
  }

  private nonisolated static func hex(_ id: EndpointId) -> String {
    id.toBytes().map { String(format: "%02x", $0) }.joined()
  }

  private static func loadSecretKeyData() -> Data? {
    guard let b64 = UserDefaults.standard.string(forKey: secretKeyDefaultsKey) else {
      return nil
    }
    return Data(base64Encoded: b64)
  }

  private static func saveSecretKey(_ key: SecretKey) {
    UserDefaults.standard.set(
      key.toBytes().base64EncodedString(), forKey: secretKeyDefaultsKey
    )
  }
}
