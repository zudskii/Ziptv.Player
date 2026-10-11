import { useNavigate } from 'react-router';

import { FullscreenMessage } from '../components/ui/FullscreenMessage';

export function NotFoundPage() {
  const navigate = useNavigate();
  return <FullscreenMessage title="Page not found" description="The page you are looking for does not exist." action={{ label: 'Go to Home', onClick: () => navigate('/') }} />;
}
