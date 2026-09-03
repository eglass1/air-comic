import React, { useState, useEffect } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  Typography,
  Box,
  Card,
  CardContent,
  CardActions,
  Chip,
  IconButton,
  CircularProgress,
  InputAdornment,
  Tooltip,
  Snackbar,
} from '@mui/material';
import PublicIcon from '@mui/icons-material/Public';
import SearchIcon from '@mui/icons-material/Search';
import RefreshIcon from '@mui/icons-material/Refresh';
import AddCircleIcon from '@mui/icons-material/AddCircle';
import MeetingRoomIcon from '@mui/icons-material/MeetingRoom';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import LanguageIcon from '@mui/icons-material/Language';
import PersonIcon from '@mui/icons-material/Person';
import { useChat } from '../context/ChatContext';
import { CreatePublicRoomDialog } from './CreatePublicRoomDialog';
import type { PublicRoomDescriptorPacket } from '../types';

interface PublicRoomsDialogProps {
  open: boolean;
  onClose: () => void;
}

export const PublicRoomsDialog: React.FC<PublicRoomsDialogProps> = ({ open, onClose }) => {
  const {
    publicRoomsList,
    refreshPublicRoomsList,
    joinPublicRoom,
    convId: currentConvId,
    roomMode: currentRoomMode,
  } = useChat();

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [snack, setSnack] = useState<string | null>(null);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await refreshPublicRoomsList();
    } finally {
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    if (open) {
      handleRefresh();
    }
  }, [open]);

  // Extract all unique tags
  const allTags = Array.from(
    new Set(
      publicRoomsList
        .flatMap((r) => r.tags || [])
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.length > 0)
    )
  );

  // Filtered rooms
  const filteredRooms = publicRoomsList.filter((room) => {
    const q = searchQuery.toLowerCase().trim();
    const matchesSearch =
      !q ||
      room.name.toLowerCase().includes(q) ||
      room.description.toLowerCase().includes(q) ||
      room.creatorScreenName.toLowerCase().includes(q) ||
      (room.tags && room.tags.some((t) => t.toLowerCase().includes(q)));

    const matchesTag = !selectedTag || (room.tags && room.tags.includes(selectedTag));

    return matchesSearch && matchesTag;
  });

  const handleCopyLink = (room: PublicRoomDescriptorPacket) => {
    const link = `${window.location.origin}${window.location.pathname}?id=${encodeURIComponent(room.convId)}&public=1&join=${encodeURIComponent(room.publicJoinToken)}`;
    navigator.clipboard.writeText(link);
    setSnack(`Copied link for "${room.name}"!`);
  };

  return (
    <>
      <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <PublicIcon color="primary" sx={{ fontSize: 28 }} />
            <Typography variant="h6" sx={{ fontWeight: 700 }}>
              Public Rooms
            </Typography>
          </Box>
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Tooltip title="Refresh">
              <span>
                <Button
                  variant="outlined"
                  size="small"
                  onClick={handleRefresh}
                  disabled={isRefreshing}
                  sx={{ minWidth: 36, px: 1, height: 32 }}
                >
                  {isRefreshing ? <CircularProgress size={16} /> : <RefreshIcon fontSize="small" />}
                </Button>
              </span>
            </Tooltip>
            <Button
              variant="contained"
              size="small"
              color="primary"
              startIcon={<AddCircleIcon />}
              onClick={() => setIsCreateOpen(true)}
              sx={{ height: 32 }}
            >
              Create
            </Button>
          </Box>
        </DialogTitle>

        <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 2, minHeight: 420 }}>
          {/* Search & Tag Filter Bar */}
          <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center', flexWrap: 'wrap' }}>
            <TextField
              size="small"
              placeholder="Search public rooms by name, topic, or creator..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              sx={{ flexGrow: 1 }}
              slotProps={{
                input: {
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchIcon fontSize="small" color="action" />
                    </InputAdornment>
                  ),
                }
              }}
            />
          </Box>

          {/* Tags bar */}
          {allTags.length > 0 && (
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.6, alignItems: 'center' }}>
              <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, mr: 0.5 }}>
                Filter:
              </Typography>
              <Chip
                label="All"
                size="small"
                clickable
                color={selectedTag === null ? 'primary' : 'default'}
                onClick={() => setSelectedTag(null)}
              />
              {allTags.map((tag) => (
                <Chip
                  key={tag}
                  label={`#${tag}`}
                  size="small"
                  clickable
                  color={selectedTag === tag ? 'primary' : 'default'}
                  onClick={() => setSelectedTag(selectedTag === tag ? null : tag)}
                />
              ))}
            </Box>
          )}

          {/* Rooms List */}
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, overflowY: 'auto', flexGrow: 1, pr: 0.5 }}>
            {isRefreshing && publicRoomsList.length === 0 ? (
              <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', py: 8, gap: 1.5 }}>
                <CircularProgress size={36} />
                <Typography variant="body2" color="text.secondary">
                  Finding active public rooms...
                </Typography>
              </Box>
            ) : filteredRooms.length === 0 ? (
              <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', py: 8, gap: 2, textAlign: 'center' }}>
                <PublicIcon sx={{ fontSize: 48, color: 'text.disabled' }} />
                <Box>
                  <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                    {searchQuery || selectedTag ? 'No matching public rooms found' : 'No active public rooms discovered yet'}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    {searchQuery || selectedTag ? 'Try adjusting your search or filter.' : 'Be the first to create and advertise a room in the directory!'}
                  </Typography>
                </Box>
                <Button variant="contained" color="primary" startIcon={<AddCircleIcon />} onClick={() => setIsCreateOpen(true)}>
                  Create a Public Room
                </Button>
              </Box>
            ) : (
              filteredRooms.map((room) => {
                const isCurrentRoom = currentRoomMode === 'public' && currentConvId === room.convId;

                return (
                  <Card
                    key={room.publicRoomId}
                    variant="outlined"
                    sx={{
                      borderColor: isCurrentRoom ? 'primary.main' : 'divider',
                      borderWidth: isCurrentRoom ? 2 : 1,
                      backgroundColor: isCurrentRoom ? 'action.hover' : 'background.paper',
                      transition: 'all 0.15s ease',
                      '&:hover': {
                        borderColor: 'primary.light',
                        boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
                      },
                    }}
                  >
                    <CardContent sx={{ pb: 1, '&:last-child': { pb: 1.5 } }}>
                      <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1 }}>
                        <Box sx={{ flexGrow: 1 }}>
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 0.5 }}>
                            <Typography variant="subtitle1" sx={{ fontWeight: 700, color: 'text.primary' }}>
                              {room.name}
                            </Typography>
                            {isCurrentRoom && (
                              <Chip label="Current Room" color="primary" size="small" sx={{ fontWeight: 600, height: 20 }} />
                            )}
                            {room.language && (
                              <Chip
                                icon={<LanguageIcon sx={{ fontSize: '14px !important' }} />}
                                label={room.language.toUpperCase()}
                                size="small"
                                variant="outlined"
                                sx={{ height: 20, fontSize: '0.7rem' }}
                              />
                            )}
                          </Box>
                          {room.description && (
                            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                              {room.description}
                            </Typography>
                          )}
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                              <PersonIcon sx={{ fontSize: 15, color: 'text.secondary' }} />
                              <Typography variant="caption" color="text.secondary">
                                Hosted by <strong>{room.creatorScreenName}</strong> ({room.creatorId.slice(0, 8)})
                              </Typography>
                            </Box>
                            {room.tags && room.tags.length > 0 && (
                              <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                                {room.tags.map((tag) => (
                                  <Chip key={tag} label={`#${tag}`} size="small" sx={{ height: 18, fontSize: '0.65rem' }} />
                                ))}
                              </Box>
                            )}
                          </Box>
                        </Box>

                        <CardActions sx={{ p: 0, display: 'flex', flexDirection: 'column', gap: 0.5, alignItems: 'flex-end' }}>
                          <Button
                            variant={isCurrentRoom ? 'outlined' : 'contained'}
                            color="primary"
                            size="small"
                            startIcon={<MeetingRoomIcon />}
                            disabled={isCurrentRoom}
                            onClick={() => {
                              joinPublicRoom(room);
                              onClose();
                            }}
                          >
                            {isCurrentRoom ? 'Inside' : 'Join'}
                          </Button>
                          <Tooltip title="Copy Shareable Link">
                            <IconButton size="small" onClick={() => handleCopyLink(room)}>
                              <ContentCopyIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        </CardActions>
                      </Box>
                    </CardContent>
                  </Card>
                );
              })
            )}
          </Box>
        </DialogContent>

        <DialogActions sx={{ px: 3, py: 1.5, justifyContent: 'space-between' }}>
          <Typography variant="caption" color="text.secondary">
            {filteredRooms.length} room{filteredRooms.length === 1 ? '' : 's'} available
          </Typography>
          <Button onClick={onClose} color="inherit">
            Close
          </Button>
        </DialogActions>
      </Dialog>

      <CreatePublicRoomDialog open={isCreateOpen} onClose={() => setIsCreateOpen(false)} />

      <Snackbar
        open={Boolean(snack)}
        autoHideDuration={3000}
        onClose={() => setSnack(null)}
        message={snack}
      />
    </>
  );
};
