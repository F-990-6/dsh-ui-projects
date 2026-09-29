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
 * Register the endpoint on the Connection service, if this composition has one.
 *
 * A composition without `connection` is legitimate (Electron serves the client over `file://` and
 * IPC), and the right answer there is a logged line and a column that says it cannot read the
 * listing — not a refused loader row.
 * @param {{ get: (name: string) => any, logger?: any }} ctx
 * @param {{ scan: () => Promise<any> }} deps
 * @returns {() => void} disposer
 */
export function registerInstalledEndpoint(ctx, { scan }) {
  const connection = ctx.get('connection')
  if (connection === undefined || typeof connection.fetch?.register !== 'function') {
    ctx.logger?.warn?.(
      '[dsh-ui-projects] no connection service in this composition; the installed-package listing is unavailable and Settings › UI plugins will say so',
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
  ctx.logger?.info?.(
    `[dsh-ui-projects] installed-package listing mounted at ${INSTALLED_PATH} and ${CHANGELOG_PATH}`,
  )
  return () => {
    void disposeInstalled?.()
    void disposeChangelog?.()
  }
}
