# Preview Diagnostics

## 2026-08-16 — light-theme verification

The regenerated static site returns complete prerendered HTML for `GET /en` from the local static server on port 3001. The document includes the bilingual public page, visible semantic headings, the journey sequence, AI QA, and fit-review form.

My Browser receives Nuxt's rendered `500` page after client hydration, reporting `Cannot access 'm' before initialization`. This is distinct from the managed Nuxt development server, which starts successfully but exits with code 0 shortly afterwards. The failure does **not** prevent production static generation: `pnpm generate` completed 40 prerendered routes successfully.

The visual fallback remains the generated page screenshots. The static client-hydration error must be diagnosed separately before treating the proxied preview as a user-accessible preview.

## 2026-08-16 — direct visual preview available

An isolated, server-rendered visual preview is now available at the public temporary proxy on port 3003. Both routes were opened successfully in My Browser and render the revised **bone + cobalt** system:

| Route | Verification result |
|---|---|
| `/en` | Loaded with the English title, paper canvas, ink type, cobalt emphasis, journey sequence, AI QA, and fit-review form. |
| `/zh-hant` | Loaded with the Traditional Chinese title, matching paper canvas, cobalt emphasis, journey sequence, AI QA, and fit-review form. |

This visual preview intentionally strips client scripts so that the known static hydration exception cannot replace the valid prerendered document with an error page. It is appropriate for direct design and content review. AI QA expansion and form submission remain disabled in this temporary visual-only route while the interactive hydration preview is repaired.

Nested content-route note: the local port-3003 response for `/en/services/seo-geo-growth-system` is HTTP 200 and contains only the retained JSON-LD script. My Browser nevertheless received a prior `Cannot access 's' before initialization` error page on the unversioned public path. Subsequent public verification must use a cache-busting preview parameter before treating that route as failed.

## 2026-08-16 — scroll-story v1 visual verification

The refreshed public visual preview includes the updated four-part journey: **Discovery**, **Clarity**, **Evidence**, and **Momentum**. Its SSR document now includes the story index, all four labelled nodes, each scene heading and explanatory text, and the abstract cobalt/signal path canvas. The first-frame visual shows the new constellation in the hero and the pale paper/mineral-blue system.

The port-3004 route is intentionally a visual-only fallback and strips client scripts; it therefore demonstrates the hierarchy, scene design, and static sticky-capable layout but not the runtime scroll-progress state. Interactive scroll validation remains contingent on repairing the normal Nuxt client hydration path.

The port-3004 preview now injects a small dependency-free scroll runtime after stripping Nuxt hydration. It changes the path progress, active node, scene core and text panel based on document scroll, and exits immediately in reduced-motion mode. The initial English public route loaded successfully after the runtime injection. Automated `browser_scroll` did not move the connected My Browser viewport despite page overflow; keyboard or manual user scrolling remains the next visual verification route.

Keyboard `PageDown` moved the public preview to approximately 826 px below the first viewport, confirming that the page can scroll. The interim screenshot showed an over-large blank transition before the approach section; this is a design issue in the v1 sticky story pacing rather than a route failure. The scroll-story needs a tighter desktop scene start and a first transition that keeps a visible scene element in frame.

Root cause and fix: `.site-shell` used `overflow:hidden`, creating a vertical scrolling ancestor that prevented `.story-sticky` from sticking. Changing it to `overflow-x:clip` preserved horizontal art clipping while restoring viewport sticky behavior. A real browser geometry check now reports the story sticky container at `top: 0`, the canvas from `64–754 px`, and the active copy from `219–599 px` during a mid-story scroll. The captured Clarity scene visibly contains the path line, numbered nodes, orbit core, active `02 / CLARITY` heading and explanatory copy.

Pointer-parallax verification: the public fallback runtime now handles mouse pointer movement after its reduced-motion guard. A real browser session was scrolled into the active `02 / CLARITY` scene, sent a mouse move over the canvas, and reported `--pointer-x: 0.8517301679826188` and `--pointer-y: 0.6115942028985508` rather than their resting `0` values. The canvas therefore visibly moves its orbit, wire, beacon, and ambient label with pointer position, while touch and reduced-motion paths retain the static reading experience.

Keyboard verification: in the public preview, the first `Tab` reached the visible `Skip to content` link and the second reached the `DISCOVERYSTACK` brand link. After a mid-story pointer move, the active element remained that same brand link and retained its visible `auto 1px` outline. The pointer runtime does not set focus or tabindex. This validates fallback-preview focus order and focus persistence; the normal Nuxt hydration route remains a separate pending verification because of its known client error.

Raw hydration caveat: the temporary `__raw/en` copy preserves Nuxt scripts for inspection, but its prerender payload still declares `/en`. Nuxt therefore redirects the browser from `/__raw/en` to `/en` during hydration and unmounts the initial tree. The observed Unhead `dispose` error occurs during that forced unmount, so this route cannot establish the root cause of normal `/en` hydration. A conclusive test must serve the original static `.output/public` at the server root on an isolated preview port; the current platform's managed dev process exits before that direct verification can be completed.

Full public preview coverage: the visual-preview builder now walks every generated HTML file below both `/en` and `/zh-hant`, rather than only transforming their homepages. `/en/services/seo-geo-growth-system` and `/zh-hant/glossary/geo` each returned 200 through port 3004, retain their canonical/hreflang/JSON-LD metadata, and contain no Nuxt module script after transformation. The visual fallback therefore supports direct review of public service, methodology, glossary and publication content pages while the normal server preview remains under repair.

Managed-preview resolution: the managed environment repeatedly terminates `nuxt dev` after a successful build, so the project `dev` command now regenerates the visual fallback and runs a small Node static server on port 3000. This server stays alive under the platform monitor and was screenshot-verified for both `/en` and `/zh-hant` with the complete bone-and-cobalt hero. It is intentionally a public visual preview: scroll-story runtime is included, whereas normal Nuxt hydration, private Audit Lab and server API interaction remain separately tracked.
