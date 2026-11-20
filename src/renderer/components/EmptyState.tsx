export function EmptyState({ glyph, title, detail }: { glyph: string; title: string; detail?: string }) {
  return (
    <div className="empty">
      <div className="empty__glyph" aria-hidden="true">
        {glyph}
      </div>
      <div className="empty__title">{title}</div>
      {detail ? <div className="empty__detail">{detail}</div> : null}
    </div>
  );
}
