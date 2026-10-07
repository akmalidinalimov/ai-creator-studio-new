import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { homeworkFileKind, maxBytesFor, MAX_DOCUMENT_BYTES, MAX_PHOTO_BYTES, sendSpec, sentFileId } from "./media.ts";

Deno.test("photos, videos, and everything else as a document (a PDF is homework too)", () => {
  assertEquals(homeworkFileKind("image/jpeg", 2_000_000), "photo");
  assertEquals(homeworkFileKind("image/png", MAX_PHOTO_BYTES + 1), "document");   // too big for sendPhoto → still sent
  assertEquals(homeworkFileKind("image/heic", 1000), "document");                 // sendPhoto can't render HEIC
  assertEquals(homeworkFileKind("video/quicktime", 40_000_000), "video");
  assertEquals(homeworkFileKind("application/pdf", 3_000_000), "document");
  assertEquals(homeworkFileKind("", 100), "document");                             // some Android pickers send no type
  assertEquals(maxBytesFor("document"), MAX_DOCUMENT_BYTES);
});

Deno.test("send method + where the file id comes back", () => {
  assertEquals(sendSpec("document"), { method: "sendDocument", field: "document" });
  assertEquals(sentFileId("document", { document: { file_id: "D1" } }), "D1");
  assertEquals(sentFileId("photo", { photo: [{ file_id: "s" }, { file_id: "L" }] }), "L");
  assertEquals(sentFileId("video", { video: { file_id: "V" } }), "V");
  assertEquals(sentFileId("document", { photo: [] }), null);
});
