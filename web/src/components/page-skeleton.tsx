import s from "./page-skeleton.module.css";

interface PageSkeletonProps {
  variant?: "rows" | "board";
  rows?: number;
  columns?: number;
  label?: string;
}

export function PageSkeleton({ variant = "rows", rows = 5, columns = 6, label = "正在加载" }: PageSkeletonProps) {
  if (variant === "board") {
    return (
      <div className={s.board} role="status" aria-live="polite" aria-label={label}>
        {Array.from({ length: columns }, (_, columnIndex) => (
          <div className={s.boardColumn} key={columnIndex}>
            <div className={s.boardHead} />
            {Array.from({ length: 3 }, (_, cardIndex) => (
              <div className={s.boardCard} key={cardIndex} />
            ))}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className={s.rows} role="status" aria-live="polite" aria-label={label}>
      {Array.from({ length: rows }, (_, index) => (
        <div className={s.row} key={index} />
      ))}
    </div>
  );
}
