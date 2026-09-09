import React, { useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  Typography,
  Box,
  Avatar,
  IconButton,
  Tooltip,
  InputAdornment,
  Grid,
  Card,
  CardContent,
  CardActions,
  Snackbar,
  Alert,
  Chip,
} from '@mui/material';
import PeopleIcon from '@mui/icons-material/People';
import SearchIcon from '@mui/icons-material/Search';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import NotesIcon from '@mui/icons-material/Notes';
import SendIcon from '@mui/icons-material/Send';
import ScheduleSendIcon from '@mui/icons-material/ScheduleSend';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import { useChat } from '../context/ChatContext';
import { Friend, Participant } from '../types';
import { PresenceDot } from './PresenceDot';
import { ContactCardDialog } from './ContactCardDialog';

interface FriendsDialogProps {
  open: boolean;
  onClose: () => void;
}

export const FriendsDialog: React.FC<FriendsDialogProps> = ({ open, onClose }) => {
  const {
    friends,
    updateFriend,
    deleteFriend,
    inviteFriendToRoom,
    isFriendOnline,
    pendingInvites,
    cancelPendingInvite,
    participants,
    isApproved,
    isRekeying,
  } = useChat();

  const [searchTerm, setSearchTerm] = useState<string>('');
  const [editingNoteFriendId, setEditingNoteFriendId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState<string>('');
  const [snack, setSnack] = useState<string | null>(null);
  const [selectedParticipant, setSelectedParticipant] = useState<Participant | null>(null);

  const approvedIds = new Set(
    participants.filter((p) => p.isApproved).map((p) => p.participantId)
  );

  const invitesByParticipant = new Map(
    pendingInvites.map((invite) => [invite.recipientParticipantId, invite])
  );

  const onlineCount = friends.filter((f) => isFriendOnline(f.participantId)).length;

  const filteredFriends = friends.filter((f) => {
    const term = searchTerm.toLowerCase();
    return (
      f.screenName.toLowerCase().includes(term) ||
      (f.notes && f.notes.toLowerCase().includes(term))
    );
  });

  const handleStartEditNote = (friend: Friend) => {
    setEditingNoteFriendId(friend.id);
    setNoteDraft(friend.notes || '');
  };

  const handleCancelEditNote = () => {
    setEditingNoteFriendId(null);
    setNoteDraft('');
  };

  const handleSaveNote = async (friend: Friend) => {
    await updateFriend({
      ...friend,
      notes: noteDraft.trim(),
    });
    setEditingNoteFriendId(null);
    setNoteDraft('');
    setSnack(`Updated note for ${friend.screenName}`);
  };

  const handleDelete = async (id: string, name: string) => {
    if (window.confirm(`Delete ${name} from your friends?`)) {
      if (editingNoteFriendId === id) {
        setEditingNoteFriendId(null);
        setNoteDraft('');
      }
      await deleteFriend(id);
      setSnack(`Removed ${name}`);
    }
  };

  const handleInvite = async (friend: Friend) => {
    const result = await inviteFriendToRoom(friend);
    if (result === 'sent') {
      setSnack(`Invitation sent to ${friend.screenName}.`);
    } else if (result === 'queued') {
      setSnack(`${friend.screenName} is offline — invitation queued until they come online.`);
    } else {
      setSnack(`Could not invite ${friend.screenName}.`);
    }
  };

  const handleViewDetails = (friend: Friend) => {
    const currentParticipant = participants.find((p) => p.participantId === friend.participantId);
    const online = isFriendOnline(friend.participantId);
    setSelectedParticipant({
      participantId: friend.participantId,
      screenName: friend.screenName,
      avatarName: friend.avatarName || currentParticipant?.avatarName,
      publicKey: friend.publicKey,
      signingPublicKey: friend.signingPublicKey,
      contactInfo: friend.contactInfo || currentParticipant?.contactInfo,
      lastSeen: currentParticipant?.lastSeen || friend.lastSeen || Date.now(),
      isSelf: false,
      status: currentParticipant?.status || (online ? 'online' : 'offline'),
      isApproved: approvedIds.has(friend.participantId),
    });
  };

  const handleClose = () => {
    setEditingNoteFriendId(null);
    setNoteDraft('');
    setSelectedParticipant(null);
    onClose();
  };

  return (
    <>
      <Dialog open={open} onClose={handleClose} maxWidth="md" fullWidth>
        <DialogTitle sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <PeopleIcon color="primary" />
            <Typography variant="h6" sx={{ fontWeight: 700 }}>
              Friends ({friends.length})
            </Typography>
            {friends.length > 0 && (
              <Chip
                size="small"
                variant="outlined"
                color={onlineCount > 0 ? 'success' : 'default'}
                label={`${onlineCount} online`}
                sx={{ height: 22, fontSize: '0.7rem' }}
              />
            )}
          </Box>
        </DialogTitle>

        <DialogContent dividers sx={{ minHeight: 420 }}>
          <TextField
            placeholder="Search friends by name, notes..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            fullWidth
            size="small"
            sx={{ mb: 2 }}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon color="action" />
                  </InputAdornment>
                ),
              },
            }}
          />

          {friends.length === 0 ? (
            <Box sx={{ textAlign: 'center', py: 6, color: 'text.secondary' }}>
              <PeopleIcon sx={{ fontSize: 48, opacity: 0.4, mb: 1 }} />
              <Typography variant="h6">No friends yet</Typography>
              <Typography variant="body2">
                When you accept entry requests or meet participants, they are saved here.
              </Typography>
            </Box>
          ) : filteredFriends.length === 0 ? (
            <Typography sx={{ py: 4, textAlign: 'center', color: 'text.secondary' }}>
              No friends matched "{searchTerm}"
            </Typography>
          ) : (
            <Grid container spacing={2}>
              {filteredFriends.map((f) => {
                const isAlreadyIn = approvedIds.has(f.participantId);
                const online = isFriendOnline(f.participantId);
                const pendingInvite = invitesByParticipant.get(f.participantId);
                const isEditingNote = editingNoteFriendId === f.id;

                return (
                  <Grid size={{ xs: 12, sm: 6 }} key={f.id}>
                    <Card
                      variant="outlined"
                      sx={{
                        height: '100%',
                        display: 'flex',
                        flexDirection: 'column',
                        bgcolor: 'background.default',
                      }}
                    >
                      <CardContent sx={{ flexGrow: 1, pb: 1 }}>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 1.5 }}>
                          <PresenceDot online={online}>
                            <Avatar sx={{ bgcolor: 'secondary.main', color: '#fff', fontWeight: 'bold' }}>
                              {f.screenName.charAt(0).toUpperCase()}
                            </Avatar>
                          </PresenceDot>
                          <Box sx={{ overflow: 'hidden', flexGrow: 1 }}>
                            <Typography variant="subtitle1" sx={{ fontWeight: 700, lineHeight: 1.2 }}>
                              {f.screenName}
                            </Typography>
                            <Typography
                              variant="caption"
                              sx={{ color: online ? 'success.main' : 'text.disabled', fontWeight: 600 }}
                            >
                              {online ? 'Online' : 'Offline'}
                            </Typography>
                          </Box>
                          <Tooltip title="View Details">
                            <IconButton
                              size="small"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleViewDetails(f);
                              }}
                              aria-label={`View details for ${f.screenName}`}
                            >
                              <InfoOutlinedIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        </Box>

                        {/* Notes with pencil icon to edit */}
                        {isEditingNote ? (
                          <Box sx={{ mt: 1 }}>
                            <TextField
                              size="small"
                              fullWidth
                              multiline
                              minRows={2}
                              maxRows={4}
                              placeholder="Add a note..."
                              value={noteDraft}
                              onChange={(e) => setNoteDraft(e.target.value)}
                              autoFocus
                              onKeyDown={(e) => {
                                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                                  e.preventDefault();
                                  handleSaveNote(f);
                                } else if (e.key === 'Escape') {
                                  handleCancelEditNote();
                                }
                              }}
                              sx={{ mb: 1, '& .MuiInputBase-input': { fontSize: '0.82rem' } }}
                            />
                            <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
                              <Button size="small" onClick={handleCancelEditNote}>
                                Cancel
                              </Button>
                              <Button
                                size="small"
                                variant="contained"
                                color="primary"
                                onClick={() => handleSaveNote(f)}
                              >
                                Save
                              </Button>
                            </Box>
                          </Box>
                        ) : (
                          <Box
                            sx={{
                              display: 'flex',
                              alignItems: 'flex-start',
                              justifyContent: 'space-between',
                              gap: 1,
                              mt: 0.5,
                            }}
                          >
                            <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, flexGrow: 1, minWidth: 0 }}>
                              <NotesIcon fontSize="small" color="action" sx={{ fontSize: 16, mt: 0.25, flexShrink: 0 }} />
                              <Typography
                                variant="caption"
                                sx={{
                                  color: f.notes?.trim() ? 'text.secondary' : 'text.disabled',
                                  fontStyle: f.notes?.trim() ? 'normal' : 'italic',
                                  wordBreak: 'break-word',
                                  whiteSpace: 'pre-wrap',
                                  fontSize: '0.78rem',
                                  lineHeight: 1.4,
                                }}
                              >
                                {f.notes?.trim() || 'No notes'}
                              </Typography>
                            </Box>
                            <Tooltip title="Edit note">
                              <IconButton
                                size="small"
                                onClick={() => handleStartEditNote(f)}
                                sx={{
                                  p: 0.25,
                                  flexShrink: 0,
                                  color: 'text.secondary',
                                  '&:hover': { color: 'primary.main' },
                                }}
                                aria-label={`Edit note for ${f.screenName}`}
                              >
                                <EditIcon sx={{ fontSize: 16 }} />
                              </IconButton>
                            </Tooltip>
                          </Box>
                        )}
                      </CardContent>

                      <CardActions sx={{ justifyContent: 'space-between', px: 2, pt: 0, pb: 1.5 }}>
                        {isApproved && !isAlreadyIn && !pendingInvite ? (
                          <Button
                            size="small"
                            variant="outlined"
                            color="primary"
                            startIcon={<SendIcon />}
                            onClick={() => handleInvite(f)}
                            disabled={isRekeying}
                          >
                            Invite to Room
                          </Button>
                        ) : pendingInvite && !isAlreadyIn ? (
                          <Tooltip
                            title={
                              online
                                ? 'Invitation delivered — waiting for them to accept'
                                : 'Queued: delivered as soon as they come online'
                            }
                          >
                            <Chip
                              icon={<ScheduleSendIcon sx={{ fontSize: '13px !important' }} />}
                              label={online ? 'Invite sent' : 'Invite queued'}
                              color="info"
                              size="small"
                              variant="outlined"
                              onDelete={() => cancelPendingInvite(pendingInvite.inviteId)}
                              sx={{ height: 24, fontSize: '0.68rem' }}
                            />
                          </Tooltip>
                        ) : (
                          <Box />
                        )}

                        <Button
                          size="small"
                          color="error"
                          startIcon={<DeleteIcon />}
                          onClick={() => handleDelete(f.id, f.screenName)}
                        >
                          Delete
                        </Button>
                      </CardActions>
                    </Card>
                  </Grid>
                );
              })}
            </Grid>
          )}
        </DialogContent>

        <DialogActions sx={{ px: 3, py: 1.5 }}>
          <Button onClick={handleClose}>Close</Button>
        </DialogActions>
      </Dialog>

      {selectedParticipant && (
        <ContactCardDialog
          participant={selectedParticipant}
          open={Boolean(selectedParticipant)}
          onClose={() => setSelectedParticipant(null)}
        />
      )}

      <Snackbar
        open={Boolean(snack)}
        autoHideDuration={3000}
        onClose={() => setSnack(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert onClose={() => setSnack(null)} severity="success" sx={{ width: '100%' }}>
          {snack}
        </Alert>
      </Snackbar>
    </>
  );
};
