import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SourceModeEditor } from "../../src/components/Editor/SourceModeEditor";
import {
  extractMarkdownOutline,
  type EditorOutlineSnapshot,
} from "../../src/lib/outline";
import {
  getSourceModeScroll,
  runSourceModeScrollToHeading,
} from "../../src/lib/source-mode-scroll";
import { SOURCE_OUTLINE_DEBOUNCE_MS } from "../../src/lib/restartable-debounce";
import { useSettings } from "../../src/store/settings";

const FILE_PATH = "/tmp/stale-source-outline.md";
const OLD_MARKDOWN = "# Alpha\n\n## Target\n\nTail";
const UPDATED_MARKDOWN = "# Alpha\n\n## Target\n\nUpdated tail";

const cases = [
  {
    name: "renaming the target heading",
    markdown: "Preface\n\n# Alpha\n\n## Renamed\n\n## Later",
  },
  {
    name: "deleting the target heading",
    markdown: "Preface\n\n# Alpha\n\nBody\n\n## Later",
  },
  {
    name: "renaming one of two duplicate headings",
    oldMarkdown: "# Alpha\n\n## Target\n\n## Target\n\nTail",
    markdown: "Preface\n\n# Alpha\n\n## Renamed\n\n## Target\n\n## Later",
  },
];

describe("SourceModeEditor stale outline navigation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useSettings.setState({ codeBlockTheme: "none" });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it.each(cases)(
    "does not use a stale position while $name is pending",
    ({ markdown, oldMarkdown = OLD_MARKDOWN }) => {
      const onOutlineChange = vi.fn<(snapshot: EditorOutlineSnapshot) => void>();
      const props = {
        filePath: FILE_PATH,
        onChange: vi.fn(),
        onOutlineChange,
        spellcheck: false,
      };
      const { rerender, unmount } = render(
        <SourceModeEditor {...props} value={oldMarkdown} initialCursor={0} />,
      );
      const staleSnapshot = onOutlineChange.mock.calls.at(-1)?.[0];
      const staleTarget = staleSnapshot?.headings.find(
        (heading) => heading.text === "Target",
      );
      expect(staleTarget).toBeDefined();
      expect(staleTarget?.pos).toBe(9);

      act(() => {
        rerender(
          <SourceModeEditor {...props} value={markdown} initialCursor={0} />,
        );
      });
      // The old outline remains published during the debounce window.
      expect(onOutlineChange.mock.calls.at(-1)?.[0]).toBe(staleSnapshot);
      expect(getSourceModeScroll(FILE_PATH)?.cursor).toBe(0);

      act(() => {
        runSourceModeScrollToHeading(FILE_PATH, staleTarget!);
      });
      // Old pos 9 is now the beginning of # Alpha. Stale fallback must be a no-op.
      expect(getSourceModeScroll(FILE_PATH)?.cursor).toBe(0);

      act(() => {
        vi.advanceTimersByTime(SOURCE_OUTLINE_DEBOUNCE_MS + 1);
      });
      const currentSnapshot = onOutlineChange.mock.calls.at(-1)?.[0];
      const laterHeading = currentSnapshot?.headings.find(
        (heading) => heading.text === "Later",
      );
      expect(laterHeading).toBeDefined();

      act(() => {
        runSourceModeScrollToHeading(FILE_PATH, laterHeading!);
      });
      expect(getSourceModeScroll(FILE_PATH)?.cursor).toBe(
        extractMarkdownOutline(markdown).find((heading) => heading.text === "Later")?.pos,
      );

      unmount();
    },
  );

  it("keeps an unchanged heading navigable from the settled outline", () => {
    const onOutlineChange = vi.fn<(snapshot: EditorOutlineSnapshot) => void>();
    const props = {
      filePath: FILE_PATH,
      onChange: vi.fn(),
      onOutlineChange,
      spellcheck: false,
    };
    const { rerender, unmount } = render(
      <SourceModeEditor {...props} value={OLD_MARKDOWN} initialCursor={0} />,
    );
    const staleTarget = onOutlineChange.mock
      .calls.at(-1)?.[0].headings.find((heading) => heading.text === "Target");
    expect(staleTarget).toBeDefined();

    act(() => {
      rerender(
        <SourceModeEditor
          {...props}
          value={UPDATED_MARKDOWN}
          initialCursor={0}
        />,
      );
      runSourceModeScrollToHeading(FILE_PATH, staleTarget!);
    });
    expect(getSourceModeScroll(FILE_PATH)?.cursor).toBe(0);

    act(() => {
      vi.advanceTimersByTime(SOURCE_OUTLINE_DEBOUNCE_MS + 1);
    });
    const settledSnapshot = onOutlineChange.mock.calls.at(-1)?.[0];
    const settledTarget = settledSnapshot?.headings.find(
      (heading) => heading.text === "Target",
    );
    expect(settledTarget).toBeDefined();
    act(() => {
      runSourceModeScrollToHeading(FILE_PATH, settledTarget!);
    });
    expect(getSourceModeScroll(FILE_PATH)?.cursor).toBe(9);

    unmount();
  });
});
