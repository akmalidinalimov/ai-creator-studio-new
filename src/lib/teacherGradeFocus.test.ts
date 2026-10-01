import { describe, expect, it } from "vitest";
import { focusSubmission, missingSubmissionMessage, readSubParam } from "./teacherGradeFocus";

const A = "0b6f4e1c-2a3d-4e5f-8a9b-0c1d2e3f4a5b";
const B = "9f8e7d6c-5b4a-4938-8271-605f4e3d2c1b";
const C = "11111111-1111-4111-8111-111111111111";
const q = [{ submission_id: A }, { submission_id: B }, { submission_id: C }];

describe("readSubParam", () => {
  it("reads a UUID ?sub= (lowercased) and ignores the tracking params", () => {
    expect(readSubParam(`?sub=${B}&src=teacher_hw_dm&ref=${B}`)).toBe(B);
    expect(readSubParam(`?sub=${B.toUpperCase()}`)).toBe(B);
    expect(readSubParam(new URLSearchParams({ sub: A }))).toBe(A);
  });
  it("anything else is null — never a free-form id into a query", () => {
    expect(readSubParam("")).toBeNull();
    expect(readSubParam(null)).toBeNull();
    expect(readSubParam("?sub=1;drop")).toBeNull();
    expect(readSubParam("?sub=../../admin")).toBeNull();
    expect(readSubParam("?src=teacher_hw_dm")).toBeNull();
  });
});

describe("focusSubmission", () => {
  it("moves THAT submission to the front; the rest keep their order", () => {
    const r = focusSubmission(q, C);
    expect(r.found).toBe(true);
    expect(r.queue.map((x) => x.submission_id)).toEqual([C, A, B]);
    expect(q.map((x) => x.submission_id)).toEqual([A, B, C]); // the input is not mutated
  });
  it("already first → unchanged; matching is case-insensitive", () => {
    expect(focusSubmission(q, A.toUpperCase()).queue.map((x) => x.submission_id)).toEqual([A, B, C]);
  });
  it("not in the queue / no id → the queue as is, found:false", () => {
    expect(focusSubmission(q, "22222222-2222-4222-8222-222222222222")).toEqual({ queue: q, found: false });
    expect(focusSubmission(q, null)).toEqual({ queue: q, found: false });
    expect(focusSubmission([], B)).toEqual({ queue: [], found: false });
  });
});

describe("missingSubmissionMessage", () => {
  it("says 'already graded' only when it is", () => {
    expect(missingSubmissionMessage("graded").title).toBe("Bu ish allaqachon baholangan");
    expect(missingSubmissionMessage("unknown").title).toBe("Bu ish navbatingizda yo'q");
  });
});
