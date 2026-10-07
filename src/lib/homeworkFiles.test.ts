import { describe, expect, it } from "vitest";
import { formatFileSize, homeworkFileKind, homeworkMaxBytes, HW_MAX_PHOTO_BYTES, pickedKind } from "./homeworkFiles";
import { pickPrompt } from "./homeworkBrief";

describe("homework files (mirror of submit-homework/media.ts)", () => {
  it("a PDF / Word file is homework too — it goes as a document", () => {
    expect(homeworkFileKind("application/pdf", 3_000_000)).toBe("document");
    expect(homeworkFileKind("application/vnd.openxmlformats-officedocument.wordprocessingml.document", 10)).toBe("document");
    expect(homeworkFileKind("", 10)).toBe("document");
    expect(homeworkMaxBytes("document")).toBe(50 * 1024 * 1024);
  });
  it("photos and videos keep their own kinds; an oversize photo goes as a file", () => {
    expect(homeworkFileKind("image/jpeg", 1000)).toBe("photo");
    expect(homeworkFileKind("image/jpeg", HW_MAX_PHOTO_BYTES + 1)).toBe("document");
    expect(pickedKind("image/jpeg")).toBe("photo"); // picked: downscaled before upload
    expect(homeworkFileKind("video/mp4", 40_000_000)).toBe("video");
    expect(homeworkFileKind("image/heic", 1000)).toBe("document");
  });
  it("formats sizes", () => {
    expect(formatFileSize(2.5 * 1024 * 1024)).toBe("2.5 MB");
    expect(formatFileSize(300)).toBe("1 KB");
  });
});

describe("homework description precedence", () => {
  const row = { id: "a", parent_id: null, description: "D", prompt_uz: null, prompt_ru: "R", prompt_en: null };
  it("language prompt, then any prompt, then description (module 2 keeps its text in description)", () => {
    expect(pickPrompt(row, "ru")).toBe("R");
    expect(pickPrompt(row, "uz")).toBe("R");
    expect(pickPrompt({ ...row, prompt_ru: null }, "uz")).toBe("D");
    expect(pickPrompt(undefined, "uz")).toBe("");
  });
});
