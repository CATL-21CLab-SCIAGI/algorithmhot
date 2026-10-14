// Papers: arXiv announcements and journal articles (Crossref), collected by the worker (server.ts) into
// the engine's material entrance. No pages of its own: papers are read where every other report is.
import { defineModule } from "@aihot/contracts/modules";

export default defineModule({ name: "research" });
