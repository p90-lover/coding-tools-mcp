"use strict";
// 0.8.122's signed proxy relay is retired: since 0.8.123 the egress router (egress-router.cjs) signs in
// to the proxy for all of the app's traffic, for every route, HTTP(S) and SOCKS alike
// (docs/specs/rewrite-the-proxy). Nothing in the app requires this file. It stays because the
// repository keeps source paths (CI: "Enforce no source-file deletion"), and it points at the router.
module.exports = require("./egress-router.cjs");
