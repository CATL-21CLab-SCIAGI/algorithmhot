// A read-only static mirror of the public pages, published to a git branch (GitHub Pages). It has no
// pages or api paths of its own: the worker crawls the running web service (server.ts).
import { defineModule } from "@aihot/contracts/modules";

export default defineModule({ name: "pages-mirror" });
