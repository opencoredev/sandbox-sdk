import { memory } from "../src/memory.js";
import { runConformance } from "../src/testing.js";
runConformance(() => memory(), { live: false });
