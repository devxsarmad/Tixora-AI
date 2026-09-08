type TixoraLoaderProps = {
  label?: string;
  variant?: 'full' | 'panel' | 'inline';
};

export function TixoraLoader({
  label = 'Loading your workspace...',
  variant = 'panel'
}: TixoraLoaderProps) {
  return (
    <div className={`tixora-loader tixora-loader-${variant}`} role="status" aria-live="polite">
      <span className="tixora-loader-mark" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span className="tixora-loader-label">{label}</span>
    </div>
  );
}
