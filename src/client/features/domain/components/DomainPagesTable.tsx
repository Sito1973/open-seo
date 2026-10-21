import { useMemo } from "react";
import { createColumnHelper, type ColumnDef } from "@tanstack/react-table";
import {
  DataTable,
  useDataTable,
  type DataTableFrameProps,
} from "@/client/components/table/DataTable";
import { ExternalUrlCell } from "@/client/components/table/url";
import { SortableHeader } from "@/client/components/table/SortableHeader";
import {
  formatNumber,
  formatRounded,
  toPageSortMode,
  domainSortColumn,
} from "@/client/features/domain/utils";
import type {
  DomainSortMode,
  PageRow,
  SortOrder,
} from "@/client/features/domain/types";

type Props = DataTableFrameProps & {
  domain: string;
  rows: PageRow[];
  sortMode: DomainSortMode;
  currentSortOrder: SortOrder;
  onSortClick: (sort: DomainSortMode) => void;
  /** Rows are the site's own Search Console pages, not DataForSEO's. */
  searchConsole?: boolean;
};

const pageColumnHelper = createColumnHelper<PageRow>();

export function DomainPagesTable({
  domain,
  rows,
  sortMode,
  currentSortOrder,
  onSortClick,
  searchConsole = false,
  ...frame
}: Props) {
  const columns = useMemo<ColumnDef<PageRow>[]>(
    () => [
      pageColumnHelper.display({
        id: "page",
        header: () => "Page",
        cell: ({ row }) => (
          <ExternalUrlCell
            value={row.original.page}
            label={row.original.relativePath ?? row.original.page}
            baseDomain={domain}
          />
        ),
        meta: {
          cellClassName: "max-w-[420px] truncate",
        },
      }),
      pageColumnHelper.accessor("organicTraffic", {
        header: () => (
          <SortableHeader
            label={searchConsole ? "Clicks" : "Organic Traffic"}
            helpText={
              searchConsole
                ? "Clicks from Google Search in Search Console's last 28 days, including queries it doesn't list."
                : undefined
            }
            column={domainSortColumn(
              toPageSortMode(sortMode) === "traffic",
              currentSortOrder,
              () => onSortClick("traffic"),
            )}
          />
        ),
        cell: ({ getValue }) => formatRounded(getValue()),
      }),
      pageColumnHelper.accessor("keywords", {
        header: () => (
          <SortableHeader
            label="Keywords"
            column={domainSortColumn(
              toPageSortMode(sortMode) === "keywords",
              currentSortOrder,
              () => onSortClick("volume"),
            )}
          />
        ),
        cell: ({ getValue }) => formatNumber(getValue()),
      }),
    ],
    [currentSortOrder, domain, onSortClick, searchConsole, sortMode],
  );
  // Memoized on purpose: a fresh slice every render defeats TanStack Table's
  // data-keyed memo, so _autoResetPageIndex fires each render and its setState
  // schedules another one — an unbounded render loop that freezes the tab.
  const tableData = useMemo(() => rows.slice(0, 100), [rows]);
  const table = useDataTable({
    data: tableData,
    columns,
  });
  return (
    <DataTable
      table={table}
      empty={{ title: "No pages match this search." }}
      {...frame}
    />
  );
}
