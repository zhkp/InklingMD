import { useState, useCallback, memo } from "react";
import { type Editor } from "@milkdown/kit/core";
import { useWorkspace } from "../../store/workspace";
import { useOutline } from "../../store/outline";
import { MarkdownEditor } from "./Editor";
import { EditorErrorBoundary } from "./EditorErrorBoundary";
import { SplitPane } from "./SplitPane";
import { TableToolbar } from "./TableToolbar";
import { SearchPanel } from "./SearchPanel";
import { type EditorOutlineSnapshot } from "../../lib/outline";

export interface EditorBodyProps {
  currentFile: string;
  splitFile: string | null;
  mainSourceMode: boolean;
  splitSourceMode: boolean;
  mainRevision: number;
  splitRevision: number;
  editorZoom: number;
  searchOpen: boolean;
  searchShowReplace: boolean;
  setSearchOpen: (open: boolean) => void;
  setSearchShowReplace: (show: boolean) => void;
  onOutlineChange?: (snapshot: EditorOutlineSnapshot) => void;
  onEditorReady: (getEditor: (() => Editor | undefined) | null) => void;
  onSplitEditorReady: (getEditor: (() => Editor | undefined) | null) => void;
  getEditor: () => Editor | undefined;
}

export const EditorBody = memo(function EditorBody({
  currentFile,
  splitFile,
  mainSourceMode,
  splitSourceMode,
  mainRevision,
  splitRevision,
  editorZoom,
  searchOpen,
  searchShowReplace,
  setSearchOpen,
  setSearchShowReplace,
  onOutlineChange,
  onEditorReady,
  onSplitEditorReady,
  getEditor,
}: EditorBodyProps) {
  // 独立订阅当前编辑内容，不让内容变更触发父级 App 组件渲染
  const currentContent = useWorkspace(
    (s) => s.openTabs.find((t) => t.path === currentFile)?.content ?? "",
  );
  const splitContent = useWorkspace((s) => {
    if (!splitFile) return "";
    return s.openTabs.find((t) => t.path === splitFile)?.content ?? "";
  });
  const toggleTabSourceMode = useWorkspace((s) => s.toggleTabSourceMode);

  const [mainInTable, setMainInTable] = useState(false);

  const handleOutlineChange = useCallback(
    (snapshot: EditorOutlineSnapshot) => {
      if (onOutlineChange) {
        onOutlineChange(snapshot);
      } else {
        useOutline.getState().publish(currentFile, snapshot);
      }
    },
    [currentFile, onOutlineChange],
  );

  return (
    <>
      {!mainSourceMode && (
        <TableToolbar getEditor={getEditor} inTable={mainInTable} />
      )}
      <div className={`editor-body${splitFile ? " editor-body-split" : ""}`}>
        <div className="editor-scroll" style={{ zoom: editorZoom }}>
          {searchOpen && !mainSourceMode && (
            <SearchPanel
              getEditor={getEditor}
              onClose={() => setSearchOpen(false)}
              showReplace={searchShowReplace}
              onShowReplaceChange={setSearchShowReplace}
            />
          )}
          <EditorErrorBoundary fileName={currentFile}>
            <MarkdownEditor
              filePath={currentFile}
              revision={mainRevision}
              value={currentContent}
              onChange={(md) =>
                useWorkspace.getState().setContentFor(currentFile, md)
              }
              onReady={onEditorReady}
              onOutlineChange={handleOutlineChange}
              onInTableChange={setMainInTable}
              sourceMode={mainSourceMode}
            />
          </EditorErrorBoundary>
        </div>
        {splitFile && (
          <SplitPane
            file={splitFile}
            content={splitContent}
            sourceMode={splitSourceMode}
            revision={splitRevision}
            editorZoom={editorZoom}
            onToggleSourceMode={() => toggleTabSourceMode(splitFile)}
            onReady={onSplitEditorReady}
          />
        )}
      </div>
    </>
  );
});
