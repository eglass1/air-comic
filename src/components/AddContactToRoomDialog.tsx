import React, { useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Typography,
  Box,
  List,
  ListItem,
  ListItemAvatar,
  ListItemText,
  Avatar,
  TextField,
  InputAdornment,
  Chip,
  CircularProgress,
  Snackbar,
  Alert,
} from '@mui/material';
import PersonAddAlt1Icon from '@mui/icons-material/PersonAddAlt1';
import SearchIcon from '@mui/icons-material/Search';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import SendIcon from '@mui/icons-material/Send';
import ScheduleSendIcon from '@mui/icons-material/ScheduleSend';
import { useChat } from '../context/ChatContext';
import { Friend } from '../types';
import { PresenceDot } from './PresenceDot';

interface AddContactToRoomDialogProps {
  open: boolean;
  onClose: () => void;
  onOpenFriends: () => void;
}

export const AddContactToRoomDialog: React.FC<AddContactToRoomDialogProps> = ({
  open,
  onClose,
  onOpenFriends,
}) => {
  const {
    friends,
    participants,
    inviteFriendToRoom,
    isFriendOnline,
    pendingInvites,
    isRekeying,
  } = useChat();
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [addingFriendId, setAddingFriendId] = useState<string | null>(null);
  const [snack, setSnack] = useState<{ message: string; severity: 'success' | 'info' | 'error' } | null>(null);

  const approvedIds = new Set(
    participants.filter((p) => p.isApproved).map((p) => p.participantId)
  );

  const filteredFriends = friends.filter((f) => {
    const term = searchTerm.toLowerCase();
    return (
      f.screenName.toLowerCase().includes(term) ||
      (f.contactInfo?.info && f.contactInfo.info.toLowerCase().includes(term)) ||
      (f.notes && f.notes.toLowerCase().includes(term))
    );
  });

  const invitedParticipantIds = new Set(pendingInvites.map((invite) => invite.recipientParticipantId));

  const handleInvite = async (friend: Friend) => {
    setAddingFriendId(friend.id);
    const result = await inviteFriendToRoom(friend);
    setAddingFriendId(null);

    if (result === 'sent') {
      setSnack({ message: `Invitation sent to ${friend.screenName}.`, severity: 'success' });
      onClose();
    } else if (result === 'queued') {
      setSnack({
        message: `${friend.screenName} is offline — the invitation will be delivered when they come online.`,
        severity: 'info',
      });
    } else {
      setSnack({ message: `Could not invite ${friend.screenName}.`, severity: 'error' });
    }
  };

  return (
    <>
      <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <PersonAddAlt1Icon color="primary" />
          <Typography variant="h6" sx={{ fontWeight: 700 }}>
            Invite Friend to Conversation
          </Typography>
        </DialogTitle>

        <DialogContent dividers sx={{ minHeight: 320 }}>
          <TextField
            placeholder="Search contacts by name, info, notes..."
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
            <Box sx={{ textAlign: 'center', py: 4, color: 'text.secondary' }}>
              <Typography variant="body2">No contacts saved in your friends directory yet.</Typography>
            </Box>
          ) : filteredFriends.length === 0 ? (
            <Typography sx={{ py: 3, textAlign: 'center', color: 'text.secondary' }}>
              No contacts matched "{searchTerm}"
            </Typography>
          ) : (
            <List sx={{ pt: 0 }}>
              {filteredFriends.map((f) => {
                const isAlreadyIn = approvedIds.has(f.participantId);
                const online = isFriendOnline(f.participantId);
                const isInvited = invitedParticipantIds.has(f.participantId);

                return (
                  <ListItem
                    key={f.id}
                    sx={{
                      mb: 1,
                      border: '1px solid',
                      borderColor: 'divider',
                      borderRadius: 2,
                      bgcolor: 'background.paper',
                    }}
                  >
                    <ListItemAvatar>
                      <PresenceDot online={online}>
                        <Avatar sx={{ bgcolor: 'secondary.main', color: '#fff', fontWeight: 'bold' }}>
                          {f.screenName.charAt(0).toUpperCase()}
                        </Avatar>
                      </PresenceDot>
                    </ListItemAvatar>

                    <ListItemText
                      primary={
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                            {f.screenName}
                          </Typography>
                          <Typography variant="caption" color={online ? 'success.main' : 'text.disabled'}>
                            {online ? 'Online' : 'Offline'}
                          </Typography>
                        </Box>
                      }
                      secondary={
                        <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
                          {f.contactInfo?.info || f.notes || `ID: ${f.participantId.slice(0, 16)}...`}
                        </Typography>
                      }
                    />

                    {isAlreadyIn ? (
                      <Chip
                        icon={<CheckCircleIcon sx={{ fontSize: '14px !important' }} />}
                        label="Already in Room"
                        color="success"
                        variant="outlined"
                        size="small"
                      />
                    ) : isInvited ? (
                      <Chip
                        icon={<ScheduleSendIcon sx={{ fontSize: '14px !important' }} />}
                        label={online ? 'Invitation sent' : 'Invite pending'}
                        color="info"
                        variant="outlined"
                        size="small"
                      />
                    ) : (
                      <Button
                        variant="contained"
                        size="small"
                        color="primary"
                        onClick={() => handleInvite(f)}
                        disabled={isRekeying || addingFriendId === f.id}
                        startIcon={addingFriendId === f.id ? <CircularProgress size={14} color="inherit" /> : <SendIcon />}
                      >
                        Invite
                      </Button>
                    )}
                  </ListItem>
                );
              })}
            </List>
          )}
        </DialogContent>

        <DialogActions sx={{ px: 3, py: 1.5, justifyContent: 'space-between' }}>
          <Button
            size="small"
            onClick={() => {
              onClose();
              onOpenFriends();
            }}
          >
            Manage Friends Directory
          </Button>
          <Button onClick={onClose}>Close</Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={Boolean(snack)}
        autoHideDuration={5000}
        onClose={() => setSnack(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert onClose={() => setSnack(null)} severity={snack?.severity || 'success'} sx={{ width: '100%' }}>
          {snack?.message}
        </Alert>
      </Snackbar>
    </>
  );
};
