// Preload for the isolation test (`node --import`): records, to the file named by SCOPE_PROBE_LOG, every read of a
// TYPESAFE_* environment variable and every attempt to reach the network, and makes those attempts fail. Nothing else
// about the process changes. It never records a value, only the variable's name or the kind of attempt.
import dns from "node:dns";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import module from "node:module";
import net from "node:net";
import process from "node:process";
import tls from "node:tls";

const log = process.env.SCOPE_PROBE_LOG;
const record = (event) => fs.appendFileSync(log, `${event}\n`);

const guarded = (name) =>
  function blocked() {
    record(`network: ${name}`);
    throw new Error(`isolation probe: ${name} is not allowed`);
  };

globalThis.fetch = guarded("fetch");
net.Socket.prototype.connect = guarded("net.Socket.connect");
net.connect = net.createConnection = guarded("net.connect");
tls.connect = guarded("tls.connect");
http.request = http.get = guarded("http.request");
https.request = https.get = guarded("https.request");
dns.lookup = guarded("dns.lookup");
dns.promises.lookup = guarded("dns.lookup");
module.syncBuiltinESMExports();

const watched = (key) => typeof key === "string" && key.startsWith("TYPESAFE_");
process.env = new Proxy(process.env, {
  get(target, key, receiver) {
    if (watched(key)) record(`env: ${key}`);
    return Reflect.get(target, key, receiver);
  },
  has(target, key) {
    if (watched(key)) record(`env: ${key}`);
    return Reflect.has(target, key);
  },
});
