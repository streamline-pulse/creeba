import ExpoModulesCore
import Foundation

/**
 * Expo ↔ native bridge. All transport logic lives in `IrohNode` (iroh-ffi + mDNS
 * via Network.framework). This module only routes calls and events.
 *
 * App frames travel as JSON strings (identical to the desktop wire format): the
 * native side does not know the hello/data semantics.
 */
public class CreebaExpoModule: Module {
  private var node: IrohNode?

  public func definition() -> ModuleDefinition {
    Name("CreebaExpo")

    Events("onReady", "onPeerOpen", "onPeerClose", "onFrame", "onError")

    AsyncFunction("start") { (identityJson: String) -> String in
      let node = self.ensureNode()
      let publicKey = try await node.start(identityJson: identityJson)
      self.sendEvent("onReady", ["publicKey": publicKey])
      return publicKey
    }

    Function("setIdentity") { (identityJson: String) in
      let node = self.ensureNode()
      Task { await node.setIdentity(identityJson) }
    }

    Function("join") { (room: String) in
      let node = self.ensureNode()
      Task { await node.join(room: room) }
    }

    Function("send") { (peerId: String, frameJson: String) in
      guard let node = self.node else { return }
      Task { await node.send(peerId: peerId, frameJson: frameJson) }
    }

    Function("broadcast") { (frameJson: String) in
      guard let node = self.node else { return }
      Task { await node.broadcast(frameJson: frameJson) }
    }

    Function("destroy") {
      let node = self.node
      self.node = nil
      Task { await node?.destroy() }
    }

    OnDestroy {
      let node = self.node
      self.node = nil
      Task { await node?.destroy() }
    }
  }

  private func ensureNode() -> IrohNode {
    if let node = node { return node }
    let created = IrohNode { [weak self] name, body in
      // Native events must be dispatched on the module's thread.
      self?.sendEvent(name, body)
    }
    node = created
    return created
  }
}
