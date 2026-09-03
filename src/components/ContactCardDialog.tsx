import React, { useState, useEffect } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Typography,
  Box,
  Avatar,
  Divider,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  Chip,
  IconButton,
  Tooltip,
  Snackbar,
  Alert,
} from '@mui/material';
import PersonIcon from '@mui/icons-material/Person';
import EmailIcon from '@mui/icons-material/Email';
import PhoneIcon from '@mui/icons-material/Phone';
import HomeIcon from '@mui/icons-material/Home';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import PersonAddIcon from '@mui/icons-material/PersonAdd';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import FingerprintIcon from '@mui/icons-material/Fingerprint';
import { Participant } from '../types';
import { getPublicKeyFingerprint, spkiToPem } from '../services/crypto';
import { useChat } from '../context/ChatContext';

interface ContactCardDialogProps {
  participant: Participant | null;
  open: boolean;
  onClose: () => void;
}

export const ContactCardDialog: React.FC<ContactCardDialogProps> = ({ participant, open, onClose }) => {
  const { friends, addFriend } = useChat();
  const [fingerprint, setFingerprint] = useState<string>('');
  const [snackMessage, setSnackMessage] = useState<string | null>(null);

  useEffect(() => {
    if (participant) {
      getPublicKeyFingerprint(participant.publicKey).then(setFingerprint);
    }
  }, [participant]);

  if (!participant) return null;

  const isFriend = friends.some(
    (f) => f.participantId === participant.participantId
  );

  const handleCopyKey = () => {
    const pem = spkiToPem(participant.publicKey);
    navigator.clipboard.writeText(pem);
    setSnackMessage('Public Key PEM copied to clipboard!');
  };

  const handleCopySigningKey = () => {
    const pem = spkiToPem(participant.signingPublicKey, 'SIGNING PUBLIC KEY');
    navigator.clipboard.writeText(pem);
    setSnackMessage('ECDSA Signing Key PEM copied to clipboard!');
  };

  const handleCopyFingerprint = () => {
    navigator.clipboard.writeText(fingerprint);
    setSnackMessage('Key fingerprint copied to clipboard!');
  };

  const handleCopyParticipantId = () => {
    navigator.clipboard.writeText(participant.participantId);
    setSnackMessage('Participant ID copied to clipboard!');
  };

  const handleAddToFriends = async () => {
    await addFriend({
      participantId: participant.participantId,
      screenName: participant.screenName,
      publicKey: participant.publicKey,
      signingPublicKey: participant.signingPublicKey,
      contactInfo: participant.contactInfo || {},
      notes: `Encountered in AirComic on ${new Date().toLocaleDateString()}`,
    });
    setSnackMessage(`${participant.screenName} added to Friends Directory!`);
  };

  return (
    <>
      <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1.5, pb: 1 }}>
          <Avatar sx={{ bgcolor: 'primary.main', color: 'primary.contrastText', width: 44, height: 44, fontWeight: 'bold' }}>
            {participant.screenName.charAt(0).toUpperCase()}
          </Avatar>
          <Box sx={{ flexGrow: 1 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Typography variant="h6" component="span" sx={{ fontWeight: 600 }}>
                {participant.screenName}
              </Typography>
              {participant.isSelf && <Chip label="You" size="small" color="primary" variant="outlined" />}
              <Chip
                label={participant.status.toUpperCase()}
                size="small"
                color={participant.status === 'online' ? 'success' : 'default'}
                sx={{ height: 20, fontSize: '0.7rem' }}
              />
            </Box>
            <Typography variant="caption" color="text.secondary">
              {isFriend ? 'In Friends Directory' : 'Participant'}
            </Typography>
          </Box>
        </DialogTitle>
        <DialogContent dividers>
          <Typography variant="subtitle2" color="primary" sx={{ mb: 1, fontWeight: 600 }}>
            INFORMATION / BIOGRAPHY
          </Typography>
          <Box sx={{ p: 1.5, bgcolor: 'background.default', borderRadius: 1.5, border: '1px solid', borderColor: 'divider' }}>
            <Typography
              variant="body2"
              sx={{
                whiteSpace: 'pre-wrap',
                color: (participant.contactInfo?.info?.trim() || participant.contactInfo?.name?.trim()) ? 'text.primary' : 'text.secondary',
                fontStyle: (participant.contactInfo?.info?.trim() || participant.contactInfo?.name?.trim()) ? 'normal' : 'italic',
              }}
            >
              {participant.contactInfo?.info?.trim() || participant.contactInfo?.name?.trim() || 'No biography or information provided.'}
            </Typography>
          </Box>

          <Divider sx={{ my: 2 }} />

          <Typography variant="subtitle2" color="primary" sx={{ mb: 1, fontWeight: 600 }}>
            PUBLIC KEYS & IDENTITY
          </Typography>
          <Box sx={{ p: 1.5, bgcolor: 'background.default', borderRadius: 1.5, border: '1px solid', borderColor: 'divider', display: 'flex', flexDirection: 'column', gap: 1 }}>
            <Box>
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 0.3 }}>
                <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
                  Participant ID (Base64URL SHA-256):
                </Typography>
                <Tooltip title="Copy Participant ID">
                  <IconButton size="small" onClick={handleCopyParticipantId}>
                    <ContentCopyIcon fontSize="inherit" />
                  </IconButton>
                </Tooltip>
              </Box>
              <Typography variant="body2" sx={{ fontFamily: 'monospace', wordBreak: 'break-all', fontSize: '0.75rem', color: 'secondary.main' }}>
                {participant.participantId}
              </Typography>
            </Box>

            <Box>
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 0.3 }}>
                <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
                  SHA-256 Fingerprint:
                </Typography>
                <Tooltip title="Copy Fingerprint">
                  <IconButton size="small" onClick={handleCopyFingerprint}>
                    <ContentCopyIcon fontSize="inherit" />
                  </IconButton>
                </Tooltip>
              </Box>
              <Typography variant="body2" sx={{ fontFamily: 'monospace', wordBreak: 'break-all', fontSize: '0.8rem', color: 'primary.light' }}>
                {fingerprint || 'Computing...'}
              </Typography>
            </Box>

            <Box sx={{ display: 'flex', gap: 1, mt: 1 }}>
              <Button size="small" variant="outlined" startIcon={<ContentCopyIcon fontSize="small" />} onClick={handleCopyKey}>
                Copy RSA Key
              </Button>
              <Button size="small" variant="outlined" startIcon={<ContentCopyIcon fontSize="small" />} onClick={handleCopySigningKey}>
                Copy ECDSA Key
              </Button>
            </Box>
          </Box>
        </DialogContent>
        <DialogActions sx={{ px: 3, py: 1.5 }}>
          {!participant.isSelf && !isFriend && (
            <Button
              variant="contained"
              color="primary"
              startIcon={<PersonAddIcon />}
              onClick={handleAddToFriends}
            >
              Add to Friends
            </Button>
          )}
          {!participant.isSelf && isFriend && (
            <Chip
              icon={<CheckCircleIcon />}
              label="Saved in Friends"
              color="success"
              variant="outlined"
              sx={{ mr: 'auto' }}
            />
          )}
          <Button onClick={onClose}>Close</Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={Boolean(snackMessage)}
        autoHideDuration={3000}
        onClose={() => setSnackMessage(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert onClose={() => setSnackMessage(null)} severity="success" sx={{ width: '100%' }}>
          {snackMessage}
        </Alert>
      </Snackbar>
    </>
  );
};
