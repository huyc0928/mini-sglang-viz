import type { View } from "./types";
import { overviewView } from "./overview";
import { callgraphView } from "./callgraph";
import { datastructsView } from "./datastructs";
import { sequenceView } from "./sequence";
import { simulatorView } from "./simulator";
import { sourceView } from "./source";

export const views: View[] = [
  overviewView,
  callgraphView,
  datastructsView,
  sequenceView,
  simulatorView,
  sourceView,
];
export type { View, ViewContext } from "./types";
