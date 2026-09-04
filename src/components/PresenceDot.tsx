import React from 'react';
import { Badge, Tooltip } from '@mui/material';

interface PresenceDotProps {
  online: boolean;
  children: React.ReactElement;
  label?: string;
}

/**
 * Wraps an avatar with a small online/offline dot fed by the presence service.
 */
export const PresenceDot: React.FC<PresenceDotProps> = ({ online, children, label }) => (
  <Tooltip title={label || (online ? 'Online now' : 'Offline')}>
    <Badge
      overlap="circular"
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      variant="dot"
      sx={{
        '& .MuiBadge-badge': {
          backgroundColor: online ? 'success.main' : 'text.disabled',
          boxShadow: (theme) => `0 0 0 2px ${theme.palette.background.paper}`,
          width: 11,
          height: 11,
          borderRadius: '50%',
        },
      }}
    >
      {children}
    </Badge>
  </Tooltip>
);
