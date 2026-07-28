---
"@streamline-pulse/creeba-core": minor
---

`CompositeTransport.addTransport()`: graft a transport onto a running
composite. It is started and receives the current identity and joined topic,
reaching parity with the existing transports. Lets a node that booted offline
attach the link to a well-known peer later (once its address/key resolves)
without restarting.
