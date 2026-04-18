interface LoadingSpinnerProps {
  size?: number;
  className?: string;
}

export function LoadingSpinner({ size = 24, className = '' }: LoadingSpinnerProps) {
  return (
    <div
      className={`inline-block border-2 border-surface-600 border-t-status-info rounded-full animate-spin ${className}`}
      style={{ width: size, height: size }}
      aria-label="Loading"
    />
  );
}
