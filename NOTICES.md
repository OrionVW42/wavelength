# Third-party notices

Wavelength is built on these open-source projects:

| Project | License | Used for |
|---|---|---|
| [Electron](https://github.com/electron/electron) | MIT | Desktop app runtime |
| [PeerJS](https://github.com/peers/peerjs) | MIT | Peer-to-peer connections for listening rooms |
| [@ghostery/adblocker-electron](https://github.com/ghostery/adblocker) | MPL-2.0 | Network ad and tracker blocking |
| [MQTT.js](https://github.com/mqttjs/MQTT.js) | MIT | Relay connection for listening rooms |
| [discord.js](https://github.com/discordjs/discord.js) | Apache-2.0 | Built-in Discord bot |
| [@discordjs/voice](https://github.com/discordjs/discord.js/tree/main/packages/voice) | Apache-2.0 | Discord voice connection |
| [opusscript](https://github.com/abalabahaha/opusscript) | MIT | Opus audio encoding for Discord |
| [@snazzah/davey](https://github.com/Snazzah/davey) | MIT | Discord end-to-end encrypted voice (DAVE) |
| [@noble/ciphers](https://github.com/paulmillr/noble-ciphers) | MIT | Voice encryption |
| [electron-builder](https://github.com/electron-userland/electron-builder) | MIT | Building the Windows installer |

Listening rooms use the free public PeerJS server (`0.peerjs.com`) only to
introduce computers to each other; you can point Wavelength at your own server
in Settings.

When a direct connection isn't possible, room messages are relayed through
the free public MQTT servers broker.emqx.io, broker.hivemq.com and
test.mosquitto.org. Messages are encrypted with AES-256-GCM using a key derived
from the room code; the servers see only encrypted data and a hashed topic.

Wavelength is not affiliated with, endorsed by, or sponsored by YouTube or
Google. YouTube Music is a trademark of Google LLC. Wavelength loads the
official YouTube Music website; your use of it is subject to YouTube's terms.
