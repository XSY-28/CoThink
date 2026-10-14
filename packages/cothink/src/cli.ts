#!/usr/bin/env -S node --
import { runCoThink } from "./index.js";
const result = await runCoThink(process.argv.slice(2));
process.exitCode = result.code;
