import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ErrorBoundary } from "@/components/ErrorBoundary";

const Boom = () => {
  throw new Error("kaboom");
};

describe("ErrorBoundary", () => {
  beforeEach(() => {
    // React logs caught errors; silence for a clean test output.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders children when they don't throw", () => {
    render(
      <ErrorBoundary>
        <div>healthy child</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText("healthy child")).toBeInTheDocument();
  });

  it("renders the fallback alert instead of crashing when a child throws", () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    // Reload control is offered.
    expect(screen.getByRole("button")).toBeInTheDocument();
  });

  it("supports a custom fallback", () => {
    render(
      <ErrorBoundary fallback={(err) => <div>custom: {err.message}</div>}>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText("custom: kaboom")).toBeInTheDocument();
  });
});
