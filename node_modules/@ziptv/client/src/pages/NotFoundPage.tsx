import { useNavigate } from 'react-router';

import { FullscreenMessage } from '../components/ui/FullscreenMessage';
import { useT } from '../i18n';

export function NotFoundPage() {
  const { t } = useT();
  const navigate = useNavigate();
  return <FullscreenMessage title={t('common.notFoundTitle')} description={t('common.notFoundText')} action={{ label: t('common.goHome'), onClick: () => navigate('/') }} />;
}
