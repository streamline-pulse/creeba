import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "Creeba Chat",
		identifier: "chat.creeba.desktop",
		version: "0.1.0",
		description: "Encrypted P2P chat — local DuckDB database, iroh (QUIC) transport and local mDNS discovery.",
	},
	scripts: {
		// For canary/stable: embed the native runtime node_modules (iroh + DuckDB)
		// into the .app. No-op in dev.
		postBuild: "scripts/postbuild.mjs",
	},
	build: {
		bun: {
			// Native modules: don't bundle, resolve from node_modules at runtime.
			// (.node bindings aren't bundlable; iroh via @number0/iroh-<platform>)
			external: [
				"@duckdb/node-api",
				"@duckdb/node-bindings",
				"@duckdb/node-bindings-darwin-arm64",
				"@duckdb/node-bindings-darwin-x64",
				"@duckdb/node-bindings-linux-arm64",
				"@duckdb/node-bindings-linux-arm64-musl",
				"@duckdb/node-bindings-linux-x64",
				"@duckdb/node-bindings-linux-x64-musl",
				"@duckdb/node-bindings-win32-arm64",
				"@duckdb/node-bindings-win32-x64",
				"@number0/iroh",
				"@number0/iroh-darwin-arm64",
				"@number0/iroh-darwin-x64",
				"@number0/iroh-linux-x64-gnu",
				"@number0/iroh-linux-x64-musl",
				"@number0/iroh-linux-arm64-gnu",
				"@number0/iroh-linux-arm64-musl",
				"@number0/iroh-win32-x64-msvc",
				"@number0/iroh-win32-arm64-msvc",
			],
		},
		// Vite builds to dist/, we copy from there
		copy: {
			"dist/index.html": "views/mainview/index.html",
			"dist/assets": "views/mainview/assets",
		},
		// Ignore Vite output in watch mode — HMR handles view rebuilds separately
		watchIgnore: ["dist/**"],
		mac: {
			bundleCEF: false,
		},
		linux: {
			bundleCEF: false,
		},
		win: {
			bundleCEF: false,
		},
	},
} satisfies ElectrobunConfig;
