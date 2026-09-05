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
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline';
import StarIcon from '@mui/icons-material/Star';
import { useChat } from '../context/ChatContext';
import { Participant } from '../types';
import { ContactCardDialog } from './ContactCardDialog';
import { AvatarHeadIcon } from './AvatarHeadIcon';

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
    openQuickMessage,
  } = useChat();

  const [selectedParticipant, setSelectedParticipant] = useState<Participant | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const onlineApprovedCount = roomMode === 'public'
    ? participants.filter((p) => p.status === 'online').length
    : participants.filter((p) => p.status === 'online' && (p.isSelf ? isApproved : p.isApproved)).length;

  const handleRemove = async (e: React.MouseEvent, p: Participant) => {
    e.stopPropagation();
    const friend = friends.find((f) => f.participantId === p.participantId);
    const name = p.screenName?.trim() || friend?.screenName?.trim() || 'this participant';
    if (
      window.confirm(
        `Are you sure you want to remove ${name} from the conversation? This will rekey the conversation to exclude them.`
      )
    ) {
      setRemovingId(p.participantId);
      await removeParticipant(p.participantId, name);
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
          const friend = friends.find(
            (f) => f.participantId === p.participantId
          );
          const isFriend = !p.isSelf && Boolean(friend);
          const displayName = p.screenName?.trim() || friend?.screenName?.trim() || 'Unknown';
          const avatarTooltip = p.isSelf
            ? 'This is you'
            : isFriend
            ? `${displayName} is your friend`
            : '';

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
              onClick={() =>
                setSelectedParticipant({
                  ...p,
                  screenName: displayName,
                  avatarName: p.avatarName || friend?.avatarName,
                })
              }
            >
              <ListItemAvatar sx={{ minWidth: 44 }}>
                <Tooltip title={avatarTooltip} arrow disableHoverListener={!avatarTooltip}>
                  <Box sx={{ position: 'relative', display: 'inline-flex' }}>
                    <Badge
                      overlap="circular"
                      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
                      variant="dot"
                      color={p.status === 'online' ? 'success' : 'default'}
                    >
                      <AvatarHeadIcon
                        avatarName={p.avatarName || friend?.avatarName}
                        screenName={displayName}
                        isSelf={p.isSelf}
                      />
                    </Badge>
                    {isFriend && (
                      <StarIcon
                        sx={{
                          position: 'absolute',
                          top: -4,
                          right: -4,
                          fontSize: 14,
                          color: '#ffb300',
                          filter: 'drop-shadow(0px 1px 1px rgba(0,0,0,0.4))',
                          pointerEvents: 'none',
                          zIndex: 1,
                        }}
                      />
                    )}
                  </Box>
                </Tooltip>
              </ListItemAvatar>

              <ListItemText
                sx={{ my: 0, minWidth: 0, flex: '1 1 auto' }}
                primary={
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6, minWidth: 0 }}>
                    <Typography
                      variant="body2"
                      noWrap
                      sx={{
                        fontWeight: 600,
                        minWidth: 0,
                        flexShrink: 1,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                      title={displayName}
                    >
                      {displayName}
                    </Typography>
                    {!p.isSelf && (
                      <Tooltip title="Quick Message">
                        <IconButton
                          size="small"
                          sx={{
                            p: 0.25,
                            flexShrink: 0,
                            color: 'text.secondary',
                            '&:hover': { color: 'primary.main' },
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            openQuickMessage({
                              participantId: p.participantId,
                              screenName: displayName,
                              avatarName: p.avatarName || friend?.avatarName,
                              publicKey: p.publicKey,
                              signingPublicKey: p.signingPublicKey,
                              peerId: p.peerId,
                            });
                          }}
                        >
                          <ChatBubbleOutlineIcon sx={{ fontSize: 16 }} />
                        </IconButton>
                      </Tooltip>
                    )}
                  </Box>
                }
              />

              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.2, flexShrink: 0, ml: 0.5 }}>
                {roomMode !== 'public' && isApproved && !p.isSelf && p.isApproved && (
                  <Tooltip title={`Remove ${displayName} from room`}>
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
                  <IconButton
                    size="small"
                    edge="end"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedParticipant({
                        ...p,
                        screenName: displayName,
                        avatarName: p.avatarName || friend?.avatarName,
                      });
                    }}
                  >
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
