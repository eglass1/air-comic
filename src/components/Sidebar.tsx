import React, { useState } from 'react';
import {
  Box,
  Typography,
  List,
  ListItem,
  ListItemAvatar,
  ListItemText,
  Avatar,
  Chip,
  Badge,
  IconButton,
  Tooltip,
  Divider,
  Button,
  CircularProgress,
} from '@mui/material';
import PeopleIcon from '@mui/icons-material/People';
import RefreshIcon from '@mui/icons-material/Refresh';
import PersonRemoveIcon from '@mui/icons-material/PersonRemove';
import PersonAddAlt1Icon from '@mui/icons-material/PersonAddAlt1';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import LockIcon from '@mui/icons-material/Lock';
import { useChat } from '../context/ChatContext';
import { Participant } from '../types';
import { ContactCardDialog } from './ContactCardDialog';
import { AvatarManager } from '../comic/avatarManager';

const AvatarHeadIcon: React.FC<{ avatarName?: string; screenName: string }> = ({
  avatarName,
  screenName,
}) => {
  const [iconUrl, setIconUrl] = useState<string | null>(null);
  const avatarManager = AvatarManager.getInstance();

  React.useEffect(() => {
    let isMounted = true;
    const cleanName = (avatarName || 'Armando').toLowerCase().replace(/\.avb$/, '');
    avatarManager.loadAvatar(cleanName).then((av) => {
      if (isMounted && av) {
        const canvas = avatarManager.renderAvatarIcon(av);
        if (canvas) {
          setIconUrl(canvas.toDataURL());
        }
      }
    });
    return () => {
      isMounted = false;
    };
  }, [avatarName]);

  if (iconUrl) {
    return (
      <Box
        component="img"
        src={iconUrl}
        alt={avatarName || screenName}
        sx={{
          width: 32,
          height: 32,
          objectFit: 'contain',
          borderRadius: '50%',
          bgcolor: 'background.paper',
          border: '1px solid',
          borderColor: 'divider',
        }}
      />
    );
  }

  return (
    <Avatar
      sx={{
        width: 32,
        height: 32,
        fontSize: '0.85rem',
        fontWeight: 700,
        bgcolor: 'primary.main',
        color: 'primary.contrastText',
      }}
    >
      {screenName.charAt(0).toUpperCase()}
    </Avatar>
  );
};

interface SidebarProps {
  onOpenInvite: () => void;
  onOpenSecurity: () => void;
  onOpenFriends: () => void;
  onOpenAddContact: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  onOpenInvite,
  onOpenSecurity,
  onOpenFriends,
  onOpenAddContact,
}) => {
  const {
    participants,
    activeEpoch,
    isApproved,
    isRekeying,
    rekeyConversation,
    removeParticipant,
    friends,
    connectedPeersCount,
    roomMode,
  } = useChat();

  const [selectedParticipant, setSelectedParticipant] = useState<Participant | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const onlineApprovedCount = roomMode === 'public'
    ? participants.filter((p) => p.status === 'online').length
    : participants.filter((p) => p.status === 'online' && (p.isSelf ? isApproved : p.isApproved)).length;

  const handleRemove = async (e: React.MouseEvent, p: Participant) => {
    e.stopPropagation();
    if (
      window.confirm(
        `Are you sure you want to remove ${p.screenName} from the conversation? This will rekey the conversation to exclude them.`
      )
    ) {
      setRemovingId(p.participantId);
      await removeParticipant(p.participantId, p.screenName);
      setRemovingId(null);
    }
  };

  return (
    <Box
      sx={{
        width: { xs: '100%', md: 310 },
        height: '100%',
        bgcolor: 'background.paper',
        borderRight: '1px solid',
        borderColor: 'divider',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Participants Header */}
      <Box
        sx={{
          p: 2,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          borderBottom: '1px solid',
          borderColor: 'divider',
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <PeopleIcon color="primary" fontSize="small" />
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
            Participants ({onlineApprovedCount})
          </Typography>
        </Box>

        <Box sx={{ display: 'flex', gap: 0.5 }}>
          {roomMode !== 'public' && isApproved && (
            <Tooltip title="Add Friend to Conversation">
              <IconButton size="small" color="primary" onClick={onOpenAddContact}>
                <PersonAddAlt1Icon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}

          {roomMode !== 'public' && isApproved && (
            <Tooltip title="Rekey Conversation">
              <IconButton
                size="small"
                color="inherit"
                onClick={rekeyConversation}
                disabled={isRekeying}
              >
                {isRekeying ? <CircularProgress size={16} color="inherit" /> : <RefreshIcon fontSize="small" />}
              </IconButton>
            </Tooltip>
          )}
        </Box>
      </Box>

      {/* Participants List */}
      <List sx={{ flexGrow: 1, overflowY: 'auto', p: 1 }}>
        {participants.map((p) => {
          const isFriend = friends.some(
            (f) => f.participantId === p.participantId
          );

          return (
            <ListItem
              key={p.participantId}
              sx={{
                borderRadius: 1.5,
                mb: 0.5,
                bgcolor: p.isSelf ? 'rgba(0, 229, 255, 0.06)' : 'transparent',
                cursor: 'pointer',
                '&:hover': {
                  bgcolor: 'action.hover',
                },
              }}
              onClick={() => setSelectedParticipant(p)}
            >
              <ListItemAvatar sx={{ minWidth: 44 }}>
                <Badge
                  overlap="circular"
                  anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
                  variant="dot"
                  color={p.status === 'online' ? 'success' : 'default'}
                >
                  <AvatarHeadIcon avatarName={p.avatarName} screenName={p.screenName} />
                </Badge>
              </ListItemAvatar>

              <ListItemText
                primary={
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.8 }}>
                    <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>
                      {p.screenName}
                    </Typography>
                    {p.isSelf && (
                      <Chip label="You" size="small" color="primary" sx={{ height: 16, fontSize: '0.65rem' }} />
                    )}
                    {isFriend && (
                      <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.68rem', fontWeight: 600 }}>
                        ★ Friend
                      </Typography>
                    )}
                  </Box>
                }
              />

              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.2 }}>
                {roomMode !== 'public' && isApproved && !p.isSelf && p.isApproved && (
                  <Tooltip title={`Remove ${p.screenName} from room`}>
                    <IconButton
                      size="small"
                      color="error"
                      onClick={(e) => handleRemove(e, p)}
                      disabled={isRekeying || removingId === p.participantId}
                    >
                      {removingId === p.participantId ? (
                        <CircularProgress size={14} color="inherit" />
                      ) : (
                        <PersonRemoveIcon fontSize="small" />
                      )}
                    </IconButton>
                  </Tooltip>
                )}

                  <Tooltip title="View Details">
                  <IconButton size="small" edge="end" onClick={(e) => { e.stopPropagation(); setSelectedParticipant(p); }}>
                    <InfoOutlinedIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Box>
            </ListItem>
          );
        })}
      </List>

      {selectedParticipant && (
        <ContactCardDialog
          participant={selectedParticipant}
          open={Boolean(selectedParticipant)}
          onClose={() => setSelectedParticipant(null)}
        />
      )}
    </Box>
  );
};
