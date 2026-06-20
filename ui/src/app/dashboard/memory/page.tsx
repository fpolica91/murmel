import { MemoryBoard } from "@/components/memory/memory-board";

/**
 * Memory view: the team's shared knowledge base — searchable, taggable markdown
 * notes that agents read on session start and write as they learn. Mounted
 * inside the authenticated dashboard shell (auth guard + team context live in
 * the dashboard layout).
 */
export default function MemoryPage() {
  return (
    <div>
      <h1 style={{ marginTop: 0 }}>Memory</h1>
      <MemoryBoard />
    </div>
  );
}
