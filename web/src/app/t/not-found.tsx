import { TableEntryView } from "@/features/entry/table-entry-view";

export default function TableNotFound() {
  return <TableEntryView entry={{ status: "not_found" }} />;
}
