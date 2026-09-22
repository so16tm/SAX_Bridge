/**
 * `node --import ./tests/bench/register.mjs <bench>` で読み込む resolve フック登録。
 */
import { register } from "node:module";

register("./hooks.mjs", import.meta.url);
