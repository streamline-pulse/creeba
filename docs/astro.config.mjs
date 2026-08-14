import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'

export default defineConfig({
  site: 'https://creeba.com',
  base: '/',
  integrations: [
    starlight({
      title: 'Creeba',
      description:
        'Local-first P2P layer for TypeScript apps: pluggable transports (iroh + mDNS), a portable op-log, opaque payloads.',
      favicon: '/favicon.svg',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/streamline-pulse/creeba',
        },
      ],
      editLink: {
        baseUrl: 'https://github.com/streamline-pulse/creeba/edit/main/docs/',
      },
      customCss: ['./src/styles/custom.css'],
      components: {
        Footer: './src/components/Footer.astro',
      },
      sidebar: [
        {
          label: 'Start here',
          items: [{ slug: 'getting-started' }],
        },
        {
          label: 'Guides',
          items: [
            { slug: 'guides/core' },
            { slug: 'guides/oplog' },
            { slug: 'guides/mesh' },
            { slug: 'guides/transport' },
            { slug: 'guides/expo' },
          ],
        },
        {
          label: 'Reference',
          items: [{ slug: 'reference/packages' }],
        },
      ],
    }),
  ],
})
