import React from 'react';
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  Tooltip,
  Typography,
} from '@mui/material';
import FavoriteIcon from '@mui/icons-material/Favorite';
import HeartBrokenIcon from '@mui/icons-material/HeartBroken';
import PublicIcon from '@mui/icons-material/Public';
import MeetingRoomIcon from '@mui/icons-material/MeetingRoom';
import LoginIcon from '@mui/icons-material/Login';
import { useChat } from '../context/ChatContext';
import { AvatarHeadIcon } from './AvatarHeadIcon';
import type { FavoriteRoomRecord } from '../types';

/** Heads shown before the list collapses into a "+N more" note. */
const MAX_FACES = 3;

const RoomFaces: React.FC<{ room: FavoriteRoomRecord }> = ({ room }) => {
  const shown = room.members.slice(0, MAX_FACES);
  const extra = room.members.length - shown.length;

  if (room.members.length === 0) {
    return (
      <Typography variant="caption" color="text.secondary" sx={{ fontStyle: 'italic' }}>
        {room.roomMode === 'public' ? 'Nobody here right now' : 'No other members recorded'}
      </Typography>
    );
  }

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6, flexWrap: 'wrap' }}>
      {shown.map((member) => (
        <AvatarHeadIcon
          key={member.participantId}
          avatarName={member.avatarName}
          screenName={member.screenName}
          title={member.screenName}
          size={28}
        />
      ))}
      <Typography variant="caption" color="text.secondary" sx={{ ml: 0.4 }}>
        {extra > 0
          ? `${shown.map((m) => m.screenName).join(', ')} (${extra} more ${
              extra === 1 ? 'person' : 'people'
            })`
          : shown.map((m) => m.screenName).join(', ')}
      </Typography>
    </Box>
  );
};

export const FavoriteRoomsDialog: React.FC<{ open: boolean; onClose: () => void }> = ({
  open,
  onClose,
}) => {
  const { favoriteRooms, removeFavoriteRoom, openFavoriteRoom, convId, roomMode } = useChat();

  const handleOpenRoom = (room: FavoriteRoomRecord) => {
    openFavoriteRoom(room);
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1.2 }}>
        <FavoriteIcon color="error" />
        Favorite Rooms
        <Chip size="small" label={favoriteRooms.length} sx={{ ml: 'auto', fontWeight: 700 }} />
      </DialogTitle>

      <DialogContent dividers sx={{ p: 0 }}>
        {favoriteRooms.length === 0 ? (
          <Box sx={{ p: 4, textAlign: 'center' }}>
            <FavoriteIcon sx={{ fontSize: 44, color: 'action.disabled', mb: 1 }} />
            <Typography variant="body2" color="text.secondary">
              No saved rooms yet.
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Use the heart button above a conversation to save it here.
            </Typography>
          </Box>
        ) : (
          favoriteRooms.map((room, index) => {
            const isCurrent = room.convId === convId && room.roomMode === roomMode;
            return (
              <React.Fragment key={room.id}>
                {index > 0 && <Divider />}
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 1.5,
                    p: 1.8,
                    bgcolor: isCurrent ? 'action.selected' : 'transparent',
                    '&:hover': { bgcolor: 'action.hover' },
                  }}
                >
                  <Tooltip title={room.roomMode === 'public' ? 'Public room' : 'Private room'}>
                    <Box
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: 38,
                        height: 38,
                        flexShrink: 0,
                        borderRadius: 2,
                        bgcolor: room.roomMode === 'public' ? 'info.main' : 'secondary.main',
                        color: '#fff',
                      }}
                    >
                      {room.roomMode === 'public' ? <PublicIcon /> : <MeetingRoomIcon />}
                    </Box>
                  </Tooltip>

                  <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <Typography
                        variant="subtitle2"
                        sx={{ fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      >
                        {room.name}
                      </Typography>
                      {isCurrent && <Chip size="small" color="primary" label="Open" />}
                    </Box>

                    {room.description && (
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ display: 'block', mb: 0.6 }}
                      >
                        {room.description}
                      </Typography>
                    )}

                    <Box sx={{ mt: 0.6 }}>
                      <RoomFaces room={room} />
                    </Box>
                  </Box>

                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexShrink: 0 }}>
                    {!isCurrent && (
                      <Tooltip title="Open this room">
                        <IconButton size="small" color="primary" onClick={() => handleOpenRoom(room)}>
                          <LoginIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    )}
                    <Tooltip title="Remove from favorites">
                      <IconButton
                        size="small"
                        color="error"
                        onClick={() => removeFavoriteRoom(room.id)}
                      >
                        <HeartBrokenIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </Box>
                </Box>
              </React.Fragment>
            );
          })
        )}
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
};
