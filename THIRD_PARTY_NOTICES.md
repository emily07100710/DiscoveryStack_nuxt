# Third-Party Notices

## GEOFlow

- Component: GEOFlow
- Upstream: https://github.com/yaojingang/GEOFlow.git
- Pinned upstream SHA: `9d70db04ee9c5d308f5fa29b4c65834229af9eea`
- Import date: 2026-08-25
- License: Apache-2.0
- Imported path: `services/geoflow`
- Import scope: the upstream product logic is unchanged in this import; DiscoveryStack adds only import and boundary metadata.

The upstream `LICENSE` and `NOTICE` are preserved byte-for-byte under
`services/geoflow/`. The original NOTICE reads:

> GEOFlow
>
> Copyright 2026 Yao Jingang
>
> GEOFlow is licensed under the Apache License, Version 2.0.
>
> See the LICENSE file for the full license text.

## Public website motion

The public Astro site uses Lenis 1.3.26 (MIT), GSAP 3.15.0 (GSAP Standard
License), Vanta 0.5.24 (MIT), and Three.js 0.134.0 (MIT). Their notices and
license files are distributed in the installed packages.

The magnetic-button proximity calculation in
`public-site/src/lib/premium-motion.ts` is adapted from the official
[Vue Bits Magnet](https://github.com/DavidHDev/vue-bits/blob/main/src/content/Animations/Magnet/Magnet.vue),
the Vue version of React Bits. Copyright (c) 2025 David Haz. Its MIT + Commons
Clause license notice is retained in that source file. The adaptation is used
as part of the DiscoveryStack website, rather than redistributed as a component.
The particle sculpture and its ribbon geometry are original application code.

## Platform identification assets

The public website includes local brand assets for identifying platform
integration options. Simple Icons paths are pinned to revision
`98820a4dc8c363ca72fa2c0d294ea4a0a9bba75d`; its CC0 license and trademark
disclaimer are retained under `public-site/public/platforms/`.
LINE, SF Express, and Google Calendar marks retain their official asset sources.
The source URLs and brand notes for all assets are recorded in
`public-site/public/platforms/SOURCES.txt`. Platform marks identify services and
do not assert commercial partnership or endorsement.
