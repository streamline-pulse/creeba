package com.creeba.expo

import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Expo ↔ native Android bridge. Transport logic lives in `IrohNode`
 * (iroh-ffi + NsdManager). App frames travel as JSON strings (wire format
 * identical to desktop).
 */
class CreebaExpoModule : Module() {
  private var node: IrohNode? = null

  override fun definition() = ModuleDefinition {
    Name("CreebaExpo")

    Events("onReady", "onPeerOpen", "onPeerClose", "onFrame", "onError")

    AsyncFunction("start") Coroutine { identityJson: String ->
      val n = ensureNode()
      val publicKey = n.start(identityJson)
      sendEvent("onReady", mapOf("publicKey" to publicKey))
      publicKey
    }

    Function("setIdentity") { identityJson: String ->
      ensureNode().setIdentity(identityJson)
    }

    Function("join") { room: String ->
      ensureNode().join(room)
    }

    Function("send") { peerId: String, frameJson: String ->
      node?.send(peerId, frameJson)
    }

    Function("broadcast") { frameJson: String ->
      node?.broadcast(frameJson)
    }

    Function("destroy") {
      node?.destroy()
      node = null
    }

    OnDestroy {
      node?.destroy()
      node = null
    }
  }

  private fun ensureNode(): IrohNode {
    return node ?: IrohNode(appContext.reactContext?.applicationContext) { name, body ->
      sendEvent(name, body)
    }.also { node = it }
  }
}
