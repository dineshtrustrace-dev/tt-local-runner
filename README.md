# TT Local Runner

One page to start, stop and watch the whole local TrusTrace stack.

```bash
cd ~/workspace/tt-local-runner
node server.js          # then open http://localhost:7777
```

No `npm install` needed (Node 22, no dependencies).

## Sections

| Section  | Cards                                                                          | Controlled with                    |
| -------- | ------------------------------------------------------------------------------ | ---------------------------------- |
| Hoop     | Login, MongoDB (:27018), Elasticsearch (:8999), Nexus (:8081)                  | `hoop login` / `hoop connect`      |
| Podman   | docker-local: rabbitmq, etcd0-2 · redis: redis, redisinsight                   | `podman start/stop <container>`    |
| Backend  | tt-service (:5001), tt-material-compliance (:8086), tt-pfd (:8091), SS API (:3585) | `java -jar …` / `npm run start:dev` |
| Frontend | SS UI (:4285), ui-real-time-coc (:4281-4284), ui-fashion-host (:4200)          | `npm start`                        |

- **Run & connect all** starts the cards ticked "in all", in order: hoop login → tunnels → containers → backends →
  frontends → host. Each stage waits until its ports are up. Progress is in the **Runner** log.
- **Stop / disconnect all** stops everything in reverse order (the hoop SSO session stays logged in).
- Each card can be started/stopped on its own; stopping one never touches the others.
- Starting a card first starts whatever it needs (`dependsOn` in `config.js`) and waits for it — e.g.
  tt-material-compliance brings up hoop login → MongoDB, Elasticsearch, Nexus before it starts.
- Java cards build automatically if no jar exists; use **Build** to rebuild after pulling.
- Click a card to see its log. Logs are also kept in `logs/<id>.log`.

## Notes

- Processes are started detached, so restarting `server.js` does not kill them; they're re-adopted by port.
- Services started outside the runner show "started outside runner" and can still be stopped from the card.
- Commands, ports, env and order are all in `config.js`.
- After a successful hoop login, the runner closes hoop's "You're logged-in!" tab in Chrome and switches back to the
  `localhost:7777` tab. macOS asks once to let your terminal control Google Chrome — allow it.
- ui-fashion-host loads Smart Segregation from the deployed URL by default. To load your local copy, set
  `"ng-smart-segregation": "http://localhost:4285/remoteEntry.json"` in
  `ui-fashion-host/manifests/dev/federation.manifest.json` (local only — don't commit).
