import assert from "node:assert/strict";
import { boxesToCellMask, parseLocateAnythingBoxes } from "../server/vision/locateAnythingPrototype.js";

const rawResponse = "<ref>face</ref><box><250><100><750><900></box>";
const boxes = parseLocateAnythingBoxes(rawResponse);

assert.deepEqual(boxes, [{ label: "face", box: [250, 100, 750, 900] }]);

const mask = boxesToCellMask(boxes, 4, 4);
assert.deepEqual([...mask], [0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0]);

console.log("LocateAnything prototype parser and cell-mask conversion: OK");
