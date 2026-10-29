// Everything the dashboard controls lives here. Edit this file, then restart `node server.js`.
//
// kinds:
//   hoop-login  — `hoop login`; status = whether `hoop admin get connections` succeeds
//   hoop        — `hoop connect <connection>`; status = local port listening
//   container   — group of existing podman containers, started/stopped together; status = combined podman
//                 state. Each container's output goes to its own log (logs/<container>.log).
//   process     — long-running command (Java service / npm dev server); status = port(s) listening
//
// `stage` controls the order used by "Run & connect all" (lowest first; items in one stage start together).
// `dependsOn` lists services that must be up first; starting a card starts (and waits for) them automatically.
// `optionalDeps` are started the same way, but if one fails to come up the card starts anyway.

const os = require('os');
const path = require('path');

const WS = path.join(os.homedir(), 'workspace');

// Resolves the runnable jar in <dir> (largest jar whose manifest has a Main-Class — not by date, since
// reproducible builds stamp Spring Boot jars 1980-02-01), building with <build> first if none exists.
const javaStart = ({ jarDir, build, javaArgs }) =>
  [
    `pick() { for f in $(ls -S ${jarDir} 2>/dev/null | grep '\\.jar$'); do unzip -p "${jarDir}/$f" META-INF/MANIFEST.MF 2>/dev/null | grep -q '^Main-Class:' && { echo "${jarDir}/$f"; return; }; done; }`,
    `JAR=$(pick)`,
    `if [ -z "$JAR" ]; then echo "[runner] no runnable jar in ${jarDir} — building first"; ${build} || exit 1; JAR=$(pick); fi`,
    `if [ -z "$JAR" ]; then echo "[runner] ✗ build produced no runnable jar in ${jarDir}"; exit 1; fi`,
    `echo "[runner] starting $JAR"`,
    `exec java ${javaArgs} -jar "$JAR"`
  ].join('\n');

const MVN_FAST = 'mvn clean install -DskipTests -Dsonar.skip=true -Dfmt.skip=true';

// Shared env for Java services: point them at the hoop tunnels instead of VPN-only hosts.
const JAVA_ENV = {
  MONGODB_PORT: '27018',
  SPRING_ELASTICSEARCH_URIS: '127.0.0.1:8999' // host:port — the services' ElasticSearchConfig rejects a scheme
};

module.exports = {
  port: 7777,

  sections: [
    { id: 'hoop', title: 'Hoop', subtitle: 'Login and tunnels to dev data stores' },
    { id: 'podman', title: 'Podman', subtitle: 'Local containers' },
    { id: 'backend', title: 'Backend', subtitle: 'Java services and NestJS API' },
    { id: 'frontend', title: 'Frontend', subtitle: 'Angular dev servers' }
  ],

  services: [
    // ── Hoop ────────────────────────────────────────────────────────────
    { id: 'hoop-login', kind: 'hoop-login', section: 'hoop', stage: 0, name: 'Hoop login', detail: 'SSO session', noLog: true },
    {
      id: 'mongo',
      kind: 'hoop',
      section: 'hoop',
      stage: 1,
      name: 'MongoDB',
      detail: 'dev-tt-app-rw',
      connection: 'dev-tt-app-rw',
      dependsOn: ['hoop-login'],
      ports: [27018]
    },
    {
      id: 'es',
      kind: 'hoop',
      section: 'hoop',
      stage: 1,
      name: 'Elasticsearch',
      detail: 'fashion-dev-elasticsearch',
      connection: 'fashion-dev-elasticsearch',
      dependsOn: ['hoop-login'],
      ports: [8999]
    },
    {
      id: 'nexus',
      kind: 'hoop',
      section: 'hoop',
      stage: 1,
      name: 'Nexus',
      detail: 'dev-nexus',
      connection: 'dev-nexus',
      dependsOn: ['hoop-login'],
      ports: [8081]
    },

    // ── Podman: one card per compose stack; each container keeps its own log ──
    {
      id: 'docker-local',
      kind: 'container',
      section: 'podman',
      stage: 2,
      name: 'docker-local',
      detail: 'rabbitmq · etcd cluster',
      containers: [
        { name: 'rabbitmq', ports: [5672, 15672] },
        { name: 'etcd0', ports: [2379] },
        { name: 'etcd1', ports: [2381] },
        { name: 'etcd2', ports: [2383] }
      ]
    },
    {
      id: 'redis-stack',
      kind: 'container',
      section: 'podman',
      stage: 2,
      name: 'redis',
      detail: 'redis · redisinsight',
      containers: [
        { name: 'redis', ports: [6379] },
        { name: 'redisinsight', ports: [5540] }
      ],
      link: 'http://localhost:5540'
    },

    // ── Backend ────────────────────────────────────────────────────────
    {
      id: 'tt-service',
      kind: 'process',
      section: 'backend',
      stage: 3,
      name: 'tt-service',
      detail: 'Spring profile: local',
      cwd: path.join(WS, 'tt-service'),
      dependsOn: ['mongo', 'es', 'nexus', 'redis-stack'],
      ports: [5001],
      env: JAVA_ENV,
      build: 'mvn clean install -Dmaven.test.skip=true',
      cmd: javaStart({
        jarDir: 'target',
        build: 'mvn clean install -Dmaven.test.skip=true',
        javaArgs: '-Dspring.profiles.active=local -DDEBUG_MODE=ON'
      }),
      startTimeoutSec: 1200
    },
    {
      id: 'tt-material-compliance',
      kind: 'process',
      section: 'backend',
      stage: 3,
      name: 'tt-material-compliance',
      detail: 'Spring profile: local',
      cwd: path.join(WS, 'tt-material-compliance'),
      dependsOn: ['mongo', 'es', 'nexus'],
      ports: [8086],
      env: JAVA_ENV,
      build: MVN_FAST,
      cmd: javaStart({ jarDir: 'tt-web/target', build: MVN_FAST, javaArgs: '-Dspring.profiles.active=local -DDEBUG_MODE=ON' }),
      startTimeoutSec: 1200
    },
    {
      id: 'tt-pfd',
      kind: 'process',
      section: 'backend',
      stage: 3,
      name: 'tt-pfd',
      detail: 'Spring profile: dev',
      cwd: path.join(WS, 'tt-pfd'),
      dependsOn: ['mongo', 'es', 'nexus', 'redis-stack'],
      optionalDeps: ['docker-local'], // rabbitmq (+ etcd) — started if possible, not required
      ports: [8091],
      env: JAVA_ENV,
      build: MVN_FAST,
      cmd: javaStart({ jarDir: 'web-api/target', build: MVN_FAST, javaArgs: '-Dspring.profiles.active=dev -DDEBUG_MODE=ON' }),
      startTimeoutSec: 1200
    },
    {
      id: 'ss-backend',
      kind: 'process',
      section: 'backend',
      stage: 3,
      name: 'smart-segregation API',
      detail: 'NestJS watch mode',
      cwd: path.join(WS, 'tt-smart-segregation'),
      ports: [3585],
      cmd: 'npm run start:dev -w backend',
      dependsOn: ['mongo', 'es', 'nexus'],
      // main.ts enables CORS only from CORS_ORIGIN (backend/.env sets CORS_ORIGINS, which main.ts doesn't read).
      // One origin only: the host shell, which is where the SS MFE runs in the browser.
      env: { CORS_ORIGIN: 'http://localhost:4200' },
      link: 'http://localhost:3585/api/docs',
      startTimeoutSec: 300
    },

    // ── Frontend ───────────────────────────────────────────────────────
    {
      id: 'ss-frontend',
      kind: 'process',
      section: 'frontend',
      stage: 4,
      name: 'smart-segregation UI',
      detail: 'MFE remote',
      cwd: path.join(WS, 'tt-smart-segregation'),
      ports: [4285],
      cmd: 'npm run start -w frontend',
      dependsOn: ['nexus'],
      startTimeoutSec: 300
    },
    {
      id: 'real-time-coc',
      kind: 'process',
      section: 'frontend',
      stage: 4,
      name: 'ui-real-time-coc',
      detail: 'MB · PS · SC · TC remotes',
      cwd: path.join(WS, 'ui-real-time-coc'),
      ports: [4281, 4282, 4283, 4284],
      cmd: 'npm run start:all',
      dependsOn: ['nexus'],
      startTimeoutSec: 600
    },
    {
      id: 'fashion-host',
      kind: 'process',
      section: 'frontend',
      stage: 5,
      name: 'ui-fashion-host',
      detail: 'Host shell — open this one',
      cwd: path.join(WS, 'ui-fashion-host'),
      ports: [4200],
      cmd: 'npm start',
      dependsOn: ['nexus'],
      link: 'http://localhost:4200',
      startTimeoutSec: 600
    }
  ]
};
