import React, { useEffect, useState } from 'react';
import { Avatar, Box } from '@mui/material';
import { AvatarManager } from '../comic/avatarManager';

interface AvatarHeadIconProps {
  avatarName?: string;
  screenName: string;
  isSelf?: boolean;
  /** Rendered size in pixels. */
  size?: number;
  title?: string;
}

/**
 * A participant's comic head, falling back to their initial while the artwork
 * loads or if the avatar cannot be found.
 */
export const AvatarHeadIcon: React.FC<AvatarHeadIconProps> = ({
  avatarName,
  screenName,
  isSelf,
  size = 32,
  title,
}) => {
  const [iconUrl, setIconUrl] = useState<string | null>(null);
  const avatarManager = AvatarManager.getInstance();

  useEffect(() => {
    let isMounted = true;
    setIconUrl(null);
    const cleanName = (avatarName || 'Armando').toLowerCase().replace(/\.avb$/, '');
    avatarManager
      .loadAvatar(cleanName)
      .then((av) => {
        if (!isMounted || !av) return;
        const canvas = avatarManager.renderAvatarIcon(av);
        if (canvas) setIconUrl(canvas.toDataURL());
      })
      .catch(() => {
        /* falls back to the initial below */
      });
    return () => {
      isMounted = false;
    };
  }, [avatarName, avatarManager]);

  const border = isSelf ? '2.5px solid' : '1px solid';
  const borderColor = isSelf ? 'primary.main' : 'divider';

  if (iconUrl) {
    return (
      <Box
        component="img"
        src={iconUrl}
        alt={title || avatarName || screenName}
        title={title}
        sx={{
          width: size,
          height: size,
          objectFit: 'contain',
          borderRadius: '50%',
          bgcolor: 'background.paper',
          border,
          borderColor,
          boxSizing: 'border-box',
        }}
      />
    );
  }

  return (
    <Avatar
      title={title}
      sx={{
        width: size,
        height: size,
        fontSize: `${Math.max(0.6, size / 38)}rem`,
        fontWeight: 700,
        bgcolor: isSelf ? 'background.paper' : 'primary.main',
        color: isSelf ? 'primary.main' : 'primary.contrastText',
        border,
        borderColor,
        boxSizing: 'border-box',
      }}
    >
      {screenName ? screenName.charAt(0).toUpperCase() : '?'}
    </Avatar>
  );
};
