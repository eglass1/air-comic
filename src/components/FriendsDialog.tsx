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
import PersonAddIcon from '@mui/icons-material/PersonAdd';
import SearchIcon from '@mui/icons-material/Search';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import EmailIcon from '@mui/icons-material/Email';
import PhoneIcon from '@mui/icons-material/Phone';
import HomeIcon from '@mui/icons-material/Home';
import NotesIcon from '@mui/icons-material/Notes';
import KeyIcon from '@mui/icons-material/VpnKey';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import SendIcon from '@mui/icons-material/Send';
import ScheduleSendIcon from '@mui/icons-material/ScheduleSend';
import { useChat } from '../context/ChatContext';
import { Friend } from '../types';
import { normalizePublicKey, spkiToPem, getParticipantId } from '../services/crypto';
import { PresenceDot } from './PresenceDot';

interface FriendsDialogProps {
  open: boolean;
  onClose: () => void;
}

export const FriendsDialog: React.FC<FriendsDialogProps> = ({ open, onClose }) => {
  const {
    friends,
    addFriend,
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
  const [editingFriend, setEditingFriend] = useState<Friend | null>(null);
  const [isAdding, setIsAdding] = useState<boolean>(false);

  // Form fields
  const [formScreenName, setFormScreenName] = useState<string>('');
  const [formPublicKey, setFormPublicKey] = useState<string>('');
  const [formSigningPublicKey, setFormSigningPublicKey] = useState<string>('');
  const [formInfo, setFormInfo] = useState<string>('');
  const [formNotes, setFormNotes] = useState<string>('');

  const [snack, setSnack] = useState<string | null>(null);

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
      (f.contactInfo?.info && f.contactInfo.info.toLowerCase().includes(term)) ||
      (f.notes && f.notes.toLowerCase().includes(term))
    );
  });

  const openAddForm = () => {
    setIsAdding(true);
    setEditingFriend(null);
    setFormScreenName('');
    setFormPublicKey('');
    setFormSigningPublicKey('');
    setFormInfo('');
    setFormNotes('');
  };

  const openEditForm = (friend: Friend) => {
    setEditingFriend(friend);
    setIsAdding(false);
    setFormScreenName(friend.screenName);
    setFormPublicKey(friend.publicKey);
    setFormSigningPublicKey(friend.signingPublicKey || '');
    setFormInfo(friend.contactInfo?.info || friend.contactInfo?.name || '');
    setFormNotes(friend.notes || '');
  };

  const handleSaveForm = async () => {
    if (!formScreenName.trim()) {
      alert('Screen name is required');
      return;
    }
    if (!formPublicKey.trim()) {
      alert('Public key is required');
      return;
    }

    const cleanPubKey = normalizePublicKey(formPublicKey.trim());
    const cleanSignKey = formSigningPublicKey.trim()
      ? normalizePublicKey(formSigningPublicKey.trim())
      : cleanPubKey; // fallback

    const participantId = await getParticipantId(cleanSignKey);

    if (editingFriend) {
      await updateFriend({
        ...editingFriend,
        participantId,
        screenName: formScreenName.trim(),
        publicKey: cleanPubKey,
        signingPublicKey: cleanSignKey,
        contactInfo: {
          info: formInfo.trim(),
        },
        notes: formNotes.trim(),
      });
      setSnack(`Updated ${formScreenName}`);
    } else {
      await addFriend({
        participantId,
        screenName: formScreenName.trim(),
        publicKey: cleanPubKey,
        signingPublicKey: cleanSignKey,
        contactInfo: {
          info: formInfo.trim(),
        },
        notes: formNotes.trim(),
      });
      setSnack(`Added ${formScreenName} to friends directory`);
    }

    setIsAdding(false);
    setEditingFriend(null);
  };

  const handleDelete = async (id: string, name: string) => {
    if (window.confirm(`Delete ${name} from your friends directory?`)) {
      await deleteFriend(id);
      setSnack(`Removed ${name}`);
    }
  };

  const handleCopyKey = (key: string, label: string) => {
    const pem = spkiToPem(key);
    navigator.clipboard.writeText(pem);
    setSnack(`${label} PEM copied to clipboard!`);
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

  return (
    <>
      <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
        <DialogTitle sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <PeopleIcon color="primary" />
            <Typography variant="h6" sx={{ fontWeight: 700 }}>
              Friends Directory ({friends.length})
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
          {!isAdding && !editingFriend && (
            <Button
              variant="contained"
              color="primary"
              size="small"
              startIcon={<PersonAddIcon />}
              onClick={openAddForm}
            >
              Add Friend
            </Button>
          )}
        </DialogTitle>

        <DialogContent dividers sx={{ minHeight: 420 }}>
          {isAdding || editingFriend ? (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 700, color: 'primary.main' }}>
                {editingFriend ? `Edit Friend: ${editingFriend.screenName}` : 'Add New Friend'}
              </Typography>

              <Grid container spacing={2}>
                <Grid size={{ xs: 12 }}>
                  <TextField
                    label="Screen Name *"
                    value={formScreenName}
                    onChange={(e) => setFormScreenName(e.target.value)}
                    fullWidth
                    required
                    placeholder="e.g. Bob"
                  />
                </Grid>
                <Grid size={{ xs: 12 }}>
                  <TextField
                    label="Encryption Public Key (RSA-OAEP Base-64 or PEM) *"
                    value={formPublicKey}
                    onChange={(e) => setFormPublicKey(e.target.value)}
                    fullWidth
                    multiline
                    rows={2}
                    required
                    placeholder="Paste participant's RSA-OAEP public key PEM or base64 SPKI here..."
                    slotProps={{
                      input: { sx: { fontFamily: 'monospace', fontSize: '0.8rem' } },
                    }}
                  />
                </Grid>
                <Grid size={{ xs: 12 }}>
                  <TextField
                    label="Signing Public Key (ECDSA Base-64 or PEM, Optional)"
                    value={formSigningPublicKey}
                    onChange={(e) => setFormSigningPublicKey(e.target.value)}
                    fullWidth
                    multiline
                    rows={2}
                    placeholder="Paste participant's ECDSA signing public key (optional)..."
                    slotProps={{
                      input: { sx: { fontFamily: 'monospace', fontSize: '0.8rem' } },
                    }}
                  />
                </Grid>
                <Grid size={{ xs: 12 }}>
                  <TextField
                    label="Information / Biography (Optional)"
                    value={formInfo}
                    onChange={(e) => setFormInfo(e.target.value)}
                    fullWidth
                    multiline
                    rows={3}
                    placeholder="Notes, interests, bio, or info about this contact..."
                  />
                </Grid>
                <Grid size={{ xs: 12 }}>
                  <TextField
                    label="Personal Notes (Optional)"
                    value={formNotes}
                    onChange={(e) => setFormNotes(e.target.value)}
                    fullWidth
                    multiline
                    rows={2}
                    placeholder="Private notes for yourself..."
                  />
                </Grid>
              </Grid>

              <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1.5, mt: 2 }}>
                <Button onClick={() => { setIsAdding(false); setEditingFriend(null); }}>
                  Cancel
                </Button>
                <Button variant="contained" color="primary" onClick={handleSaveForm}>
                  Save Friend
                </Button>
              </Box>
            </Box>
          ) : (
            <Box>
              <TextField
                placeholder="Search friends by name, info, notes..."
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
                  <Typography variant="h6">No friends in directory yet</Typography>
                  <Typography variant="body2" sx={{ mb: 2 }}>
                    When you accept entry requests or meet participants, they are saved here. You can also add contacts manually.
                  </Typography>
                  <Button variant="outlined" startIcon={<PersonAddIcon />} onClick={openAddForm}>
                    Add First Friend
                  </Button>
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

                    return (
                      <Grid size={{ xs: 12, sm: 6 }} key={f.id}>
                        <Card variant="outlined" sx={{ height: '100%', display: 'flex', flexDirection: 'column', bgcolor: 'background.default' }}>
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
                              {isAlreadyIn && (
                                <Chip
                                  icon={<CheckCircleIcon sx={{ fontSize: '13px !important' }} />}
                                  label="In Room"
                                  color="success"
                                  size="small"
                                  variant="outlined"
                                  sx={{ height: 20, fontSize: '0.65rem' }}
                                />
                              )}
                            </Box>

                            {/* Contact Details / Info */}
                            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, mb: 1.5 }}>
                              {(f.contactInfo?.info || f.contactInfo?.name) && (
                                <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'pre-wrap', fontStyle: 'italic' }}>
                                  "{f.contactInfo.info || f.contactInfo.name}"
                                </Typography>
                              )}
                              {f.notes && (
                                <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, mt: 0.5 }}>
                                  <NotesIcon fontSize="small" color="action" sx={{ fontSize: 16, mt: 0.2 }} />
                                  <Typography variant="caption" color="text.secondary">
                                    {f.notes}
                                  </Typography>
                                </Box>
                              )}
                            </Box>

                            {/* Key Snippet */}
                            <Box sx={{ p: 1, bgcolor: 'background.paper', borderRadius: 1, border: '1px solid', borderColor: 'divider' }}>
                              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <Typography variant="caption" color="primary" sx={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 0.5 }}>
                                  <KeyIcon sx={{ fontSize: 14 }} /> ID: {f.participantId.substring(0, 12)}...
                                </Typography>
                                <Tooltip title="Copy Public Key PEM">
                                  <IconButton size="small" onClick={() => handleCopyKey(f.publicKey, 'Public Key')}>
                                    <ContentCopyIcon sx={{ fontSize: 14 }} />
                                  </IconButton>
                                </Tooltip>
                              </Box>
                              <Typography variant="caption" sx={{ fontFamily: 'monospace', fontSize: '0.68rem', color: 'text.secondary', display: 'block', wordBreak: 'break-all' }}>
                                {f.publicKey.substring(0, 30)}...
                              </Typography>
                            </Box>
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
                            ) : <Box />}

                            <Box sx={{ display: 'flex', gap: 0.5 }}>
                              <Button size="small" startIcon={<EditIcon />} onClick={() => openEditForm(f)}>
                                Edit
                              </Button>
                              <Button size="small" color="error" startIcon={<DeleteIcon />} onClick={() => handleDelete(f.id, f.screenName)}>
                                Delete
                              </Button>
                            </Box>
                          </CardActions>
                        </Card>
                      </Grid>
                    );
                  })}
                </Grid>
              )}
            </Box>
          )}
        </DialogContent>

        <DialogActions sx={{ px: 3, py: 1.5 }}>
          <Button onClick={onClose}>Close</Button>
        </DialogActions>
      </Dialog>

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
