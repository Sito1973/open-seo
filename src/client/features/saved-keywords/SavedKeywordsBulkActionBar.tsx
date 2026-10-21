import { Copy, FileDown, Gauge, Sheet, Tags, Trash2 } from "lucide-react";
import { useEstimateDifficulty } from "@/client/features/keywords/hooks/useEstimateDifficulty";
import {
  TableBulkActionBar,
  TableBulkActionButton,
  TableBulkExportMenu,
} from "@/client/components/table/TableBulkActionBar";
import type { SavedKeywordRow } from "@/types/keywords";

export function SavedKeywordsBulkActionBar({
  selectedCount,
  onCopy,
  onOpenTags,
  onExportCsv,
  onExportSheets,
  onDelete,
  onClear,
  exportingSelection,
  projectId,
  selectedRows,
}: {
  selectedCount: number;
  onCopy: () => void;
  onOpenTags: () => void;
  onExportCsv: () => void;
  onExportSheets: () => void;
  onDelete: () => void;
  onClear: () => void;
  exportingSelection: boolean;
  projectId: string;
  selectedRows: SavedKeywordRow[];
}) {
  const difficulty = useEstimateDifficulty(projectId, [
    "savedKeywords",
    projectId,
  ]);
  if (selectedCount === 0) return null;

  return (
    <TableBulkActionBar
      selectedCount={selectedCount}
      onClear={onClear}
      actions={
        <>
          <div className="flex items-center gap-0.5 px-1.5">
            <TableBulkActionButton
              icon={<Tags className="size-3.5" />}
              onClick={onOpenTags}
            >
              Tag
            </TableBulkActionButton>

            {difficulty.available ? (
              <TableBulkActionButton
                icon={<Gauge className="size-3.5" />}
                onClick={() => difficulty.estimate(selectedRows)}
                disabled={difficulty.pending}
              >
                Estimate<span className="hidden md:inline"> difficulty</span>
              </TableBulkActionButton>
            ) : null}

            <TableBulkExportMenu
              busy={exportingSelection}
              actions={[
                {
                  label: "Copy keywords",
                  icon: <Copy className="size-4" />,
                  onClick: onCopy,
                },
                {
                  label: "Export to Sheets",
                  icon: <Sheet className="size-4" />,
                  onClick: onExportSheets,
                },
                {
                  label: "Export CSV",
                  icon: <FileDown className="size-4" />,
                  onClick: onExportCsv,
                },
              ]}
            />
          </div>

          <div className="flex items-center border-l border-border px-1.5">
            <TableBulkActionButton
              icon={<Trash2 className="size-3.5" />}
              onClick={onDelete}
              variant="danger"
            >
              Delete
            </TableBulkActionButton>
          </div>
        </>
      }
    />
  );
}
