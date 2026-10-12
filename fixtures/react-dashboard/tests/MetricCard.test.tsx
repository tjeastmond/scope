import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MetricCard } from "../src/components/MetricCard";

describe("MetricCard", () => {
  it("shows the title and the formatted value", () => {
    render(
      <MetricCard
        title="p95 latency"
        metric={{ id: "latency", value: 250, previous: 200, unit: "ms", history: [1, 2, 3], updatedAt: "2025-06-03T09:30:00Z" }}
      />,
    );
    expect(screen.getByText("p95 latency")).toBeTruthy();
    expect(screen.getByText("250 ms")).toBeTruthy();
  });
});
