/**
 * The read-only installed-package endpoint.
 *
 * WHY THE CONNECTION'S FETCH REGISTRY, AND NOT `webServer.register`. The webserver implements no
 * authentication of any kind — no address check, no origin check, nothing (`/plugins/**` is served
 * to whoever can reach the port, which is right for a bundle and wrong for a listing that names every
 * installed package and where it lives on disk). The Connection service's fetch registry rides the
 * `/api` channel, which applies the configured Host/Origin fence and then browser authentication,
 * and its registrations belong to the CALLER's fiber — so this route goes away with this row, like
 * every other effect in this package.
 *
 * WHY THE PAYLOAD IS A PROJECTION. `scanProfile` is built for a person running the CLI: it carries
 * absolute directories, the real path a `link:` resolves to, and the hash-level detail. Over a wire
 * none of that is needed to render the column, so the endpoint sends identity, composition state and
 * problems, and nothing else.
 */

import { CHANGELOG_REASONS, readChangelogAt, summarizeChangelog } from './changelog.js'
import { CHANNELS, DEFAULT_CHANNEL } from './update-check.js'

/** The route the page asks for. Namespaced, so a future endpoint cannot collide with it. */
/*
 * UNDER `/api`, which is not cosmetic: that prefix is where the Host/Origin fence and the browser
 * session live (`API_PATH = "/api"`, "the /api URL prefix — single source for both halves of the web
 * transport"), and every shipped fetch route is registered there — `/api/file`,
 * `/api/session.uploadFileBinary`, `/api/present.open`, `/api/session.export`. A route registered
 * outside it is served with no authentication at all.
 */
export const INSTALLED_PATH = '/api/ui-projects/installed.json'

/**
 * The second route: one package's CHANGELOG, read on demand (step 56b).
 *
 * The same fence as the listing, for the same reason, and the same failure shape: a package whose
 * changelog cannot be read is a PAYLOAD with a reason, not a 500.
 */
export const CHANGELOG_PATH = '/api/ui-projects/changelog.json'

/** Bumped when the payload's shape changes, so a newer client can refuse to guess. */
export const INSTALLED_SCHEMA_VERSION = 1

/**
 * The third route: what the registry says about the installed packages, asked for ON DEMAND (phase 3,
 * step 1).
 *
 * SEPARATE FROM THE LISTING ON PURPOSE, and that separation IS the "does not block the first frame"
 * property: the listing is what the column needs to render a row at all and is read once when the
 * section opens, while this route answers the slower, optional question — "is there something newer?" —
 * and a page that never asks it costs no network at all. Nothing on the boot path calls it; the first
 * frame is the marker, the rows and the inlined CSS, and none of them wait for a registry.
 */
export const UPDATES_PATH = '/api/ui-projects/updates.json'

/** One dependency, as the column needs it. No paths: see the header. */
function projectDependency(dependency) {
  return {
    name: dependency.name,
    spec: dependency.spec,
    resolved: dependency.resolved,
    version: dependency.version,
    kind: dependency.kind,
    bundled: dependency.bundled,
    projectId: dependency.projectId,
    /*
     * §五's row facts, added in step 56a: the package's own description and author, and the seven
     * `dsh.uiProject` fields a row renders.
     *
     * `null` is "the package declares nothing"; a MISSING key is "the host that answered is older
     * than this page". The two must not collapse — the row says different sentences for them — which
     * is why these are always present, exactly like `contract.reason`.
     */
    description: dependency.description ?? null,
    author: dependency.author ?? null,
    uiProject: dependency.uiProject ?? null,
    /*
     * STEP 5: WHERE IT CAME FROM (decision 2026-09-30). `spec` is already above; `via` is new — a `link`
     * and a store copy are different answers, and the diagnostics say which one this is.
     *
     * THE VERSION HISTORY IS NOT HERE, and that is deliberate: it lives on the SCAN, not on the row, and
     * this projection function receives only the dependency. A first attempt to look it up here read an
     * undeclared `scan` — optional chaining does not protect an undeclared identifier, so it threw, the
     * handler's catch turned the whole listing into an error payload, and every row lost its `uiProject`.
     * The history must be threaded in through `projectScan`, which is where the scan is in scope.
     */
    via: dependency.via ?? null,
    /*
     * The newest CHANGELOG heading, for the folded row. `null` is "there is nothing to name" — no
     * file, no `## ` section, or a file whose head could not be read — and the row then says just
     * "CHANGELOG" until it is opened. Present in both states, like everything else here.
     */
    changelogHeading: dependency.changelogHeading ?? null,
    problems: dependency.problems,
    /*
     * The UI Contract scan (step 9a), projected as-is.
     *
     * `scanned: false` travels with its `reason`, and every field is present in both states — `reason` is
     * `null` rather than `undefined` on purpose, because `JSON.stringify` DROPS an undefined property and
     * the column would then have to guess whether the host is old or the answer is "nothing to scan".
     */
    contract: dependency.contract,
  }
}

/** @param {any} scan @returns {any} the wire shape of one profile scan */
export function projectScan(scan) {
  return {
    profileName: scan.profileName,
    readAt: scan.readAt,
    dependencies: scan.dependencies.map(projectDependency),
    bundles: scan.bundles,
    uiProjectPackages: scan.uiProjectPackages,
    orphanedBindings: scan.orphanedBindings,
    unresolved: scan.unresolved,
    problems: scan.problems,
    /*
     * Version snapshots per package, and the field is the reason the client can say something useful
     * rather than "no snapshots": `undefined` means the host that answered has no such code (a restart
     * that has not happened yet), while `{}` or `{ pkg: [] }` means it looked and there were none. The
     * client renders a different sentence for each, so the two must not be collapsed here.
     *
     * The schema version is deliberately NOT bumped: the field is additive, a client that does not know
     * it ignores it, and a client that does reads `scan.versions ?? {}`.
     */
    versions: scan.versions,
  }
}

/** @param {unknown} body */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/**
 * The Fetch-shaped handler.
 *
 * A failure is a PAYLOAD, never a throw: the column renders "cannot read the listing" with the
 * reason, and a 500 would only make it guess. The status stays 200 because the request itself
 * succeeded — what failed is the scan behind it, and that distinction is the whole content of the
 * error object.
 * @param {{ scan: () => Promise<any> }} deps
 */
export function createInstalledHandler({ scan }) {
  return async function handle() {
    try {
      return jsonResponse({ schemaVersion: INSTALLED_SCHEMA_VERSION, scan: projectScan(await scan()) })
    } catch (error) {
      return jsonResponse({
        schemaVersion: INSTALLED_SCHEMA_VERSION,
        error: { message: typeof error?.message === 'string' ? error.message : String(error) },
      })
    }
  }
}

/**
 * The Fetch-shaped handler for ONE package's changelog.
 *
 * THE NAME IS A LOOKUP KEY, NEVER A PATH SEGMENT. `?name=` is matched against the same scan the
 * listing comes from, and the directory that gets read is the one that entry resolved — so a name that
 * is not installed (`../../etc`, an empty string, a package that has since been removed) is answered
 * WITHOUT TOUCHING A FILESYSTEM. That is the whole defence, and the suite asserts it on the READER
 * ("nothing was read") rather than on the refusal sentence, because a refusal that still read
 * something would pass the weaker test.
 *
 * `read` is injected so that assertion is possible at all; it defaults to the real reader, so the
 * composition wires nothing and there is one implementation of "read a changelog".
 * @param {{ scan: () => Promise<any>, read?: (dir: string) => Promise<{ ok: boolean, text?: string, reason?: string, detail?: string | null }> }} deps
 */
export function createChangelogHandler({ scan, read = readChangelogAt }) {
  return async function handle(request) {
    const name = new URL(request?.url ?? '/', 'http://localhost').searchParams.get('name') ?? ''
    /** @type {{ schemaVersion: number, name: string, reason: string | null, detail: string | null, sections: any[] }} */
    const answer = {
      schemaVersion: INSTALLED_SCHEMA_VERSION,
      name,
      reason: CHANGELOG_REASONS.notInstalled,
      detail: null,
      sections: [],
    }
    try {
      const raw = await scan()
      const dependency = (raw?.dependencies ?? []).find((entry) => entry?.name === name)
      if (dependency === undefined || dependency.resolved !== true || typeof dependency.dir !== 'string') {
        return jsonResponse(answer)
      }
      const result = await read(dependency.dir)
      if (result?.ok !== true) {
        return jsonResponse({
          ...answer,
          reason: result?.reason ?? CHANGELOG_REASONS.unreadable,
          detail: result?.detail ?? null,
        })
      }
      const summary = summarizeChangelog(result.text)
      return jsonResponse({ ...answer, reason: summary.reason, sections: summary.sections })
    } catch (error) {
      /*
       * The scan itself failed, or a reader threw where it should have returned an answer. The row can
       * honestly say one thing about that: the changelog could not be read, and here is why.
       */
      return jsonResponse({
        ...answer,
        reason: CHANGELOG_REASONS.unreadable,
        detail: typeof error?.message === 'string' ? error.message : String(error),
      })
    }
  }
}

/**
 * The channels a caller sent with the request, validated against this build's list.
 *
 * `?channels=<pkg>:<ch>,<pkg>:<ch>`, parsed exactly like `?name=` above: `URLSearchParams` over
 * `request?.url`, tolerating a plain `{ url }` object as well as a real `Request`. Anything this build
 * does not recognise is DROPPED, never adopted and never thrown — a typo must not be able to make a
 * check answer for a dist-tag nobody chose, and a malformed parameter must behave as if it were absent.
 * @param {any} request
 * @returns {Record<string, string>}
 */
function parseChannels(request) {
  const carried = {}
  try {
    const raw = new URL(request?.url ?? '/', 'http://localhost').searchParams.get('channels')
    if (typeof raw !== 'string' || raw === '') return carried
    for (const pair of raw.split(',')) {
      const at = pair.indexOf(':')
      if (at <= 0) continue
      const name = pair.slice(0, at)
      const channel = pair.slice(at + 1)
      if (name !== '' && CHANNELS.includes(channel)) carried[name] = channel
    }
  } catch {
    // A request whose url cannot be parsed carries no channels, which is the pre-B1 behaviour.
  }
  return carried
}

/**
 * The Fetch-shaped handler for the update check.
 *
 * `channels` is how the handler learns which dist-tag to compare each package against, and it is injected
 * because the settings document is read by the row that owns the namespace (`src/host/index.js`) — this
 * file never touches a settings service, a filesystem or a network itself. `check` is injected for the
 * same reason, and it is the ONLY thing here that talks to a registry: the three branches that matter
 * (answered, refused, never answered) belong to `update-check.js`, where they are testable.
 *
 * THE PRECEDENCE IS request → document → default. The request wins for the packages it mentions because
 * the caller is the page that SHOWS the choice to the user, and in the desktop application the document
 * it would otherwise be read from never receives our write at all (branch A). Everything the request
 * does not mention still comes from the document, so an existing caller that sends nothing — every web
 * session — behaves exactly as before.
 *
 * A failure is a PAYLOAD, like every other route here: a check that could not run says so, and a 500
 * would only make the column guess.
 * @param {{ scan: () => Promise<any>, channels?: (name: string) => string, check?: (packages: any[]) => Promise<any> }} deps
 */
export function createUpdatesHandler({
  scan,
  channels = () => DEFAULT_CHANNEL,
  check = async () => ({ checkedAt: null, results: [] }),
}) {
  return async function handle(request) {
    try {
      const carried = parseChannels(request)
      const raw = await scan()
      const packages = (raw?.dependencies ?? [])
        .filter((dependency) => dependency?.resolved === true && typeof dependency.name === 'string')
        .map((dependency) => ({
          name: dependency.name,
          version: dependency.version ?? null,
          channel: carried[dependency.name] ?? channels(dependency.name),
        }))
      const result = await check(packages)
      return jsonResponse({
        schemaVersion: INSTALLED_SCHEMA_VERSION,
        checkedAt: result?.checkedAt ?? null,
        results: result?.results ?? [],
      })
    } catch (error) {
      return jsonResponse({
        schemaVersion: INSTALLED_SCHEMA_VERSION,
        error: { message: typeof error?.message === 'string' ? error.message : String(error) },
      })
    }
  }
}

/**
 * Register the endpoint on the Connection service, if this composition has one.
 *
 * A composition without `connection` is legitimate (Electron serves the client over `file://` and
 * IPC), and the right answer there is a logged line and a column that says it cannot read the
 * listing — not a refused loader row.
 * @param {{ get: (name: string) => any, logger?: any }} ctx
 * @param {{ scan: () => Promise<any>, channels?: (name: string) => string, check?: (packages: any[]) => Promise<any> }} deps
 * @returns {() => void} disposer
 */
export function registerInstalledEndpoint(ctx, { scan, channels = () => DEFAULT_CHANNEL, check = async () => ({ checkedAt: null, results: [] }) }) {
  const connection = ctx.get('connection')
  if (connection === undefined || typeof connection.fetch?.register !== 'function') {
    ctx.logger?.warn?.(
      '[dsh-ui-projects] no connection service in this composition; the installed-package listing is unavailable and Settings › UI will say so',
    )
    return () => {}
  }
  const disposeInstalled = connection.fetch.register({
    path: INSTALLED_PATH,
    methods: ['GET'],
    // The same declaration every shipped route makes. A GET answers from a buffered request; the
    // streaming mode belongs to uploads.
    requestBody: 'buffered',
    fetch: createInstalledHandler({ scan }),
  })
  /*
   * The changelog route rides the same fence and the same scan, and it is registered HERE rather than
   * in a function of its own so that "the routes this package mounts" stays one list: a route added
   * somewhere else would be a route whose authentication nobody reviewed.
   */
  const disposeChangelog = connection.fetch.register({
    path: CHANGELOG_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: createChangelogHandler({ scan }),
  })
  /*
   * The update check rides the same fence and the same scan. It is the only route here that can reach a
   * registry, it is asked for explicitly by the column after the listing has rendered, and it never
   * installs anything — the column prints the command a person would run.
   */
  const disposeUpdates = connection.fetch.register({
    path: UPDATES_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: createUpdatesHandler({ scan, channels, check }),
  })
  ctx.logger?.info?.(
    `[dsh-ui-projects] installed-package listing mounted at ${INSTALLED_PATH}, ${CHANGELOG_PATH} and ${UPDATES_PATH}`,
  )
  return () => {
    void disposeInstalled?.()
    void disposeChangelog?.()
    void disposeUpdates?.()
  }
}
