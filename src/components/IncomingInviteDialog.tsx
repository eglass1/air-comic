import React, { useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Typography,
  Box,
  Avatar,
  Chip,
  CircularProgress,
} from '@mui/material';
import MarkEmailUnreadIcon from '@mui/icons-material/MarkEmailUnread';
import LockIcon from '@mui/icons-material/Lock';
import PublicIcon from '@mui/icons-material/Public';
import { useChat } from '../context/ChatContext';

/**
 * Prompts the user when a friend invites them into a room. Accepting opens the
 * room and performs the ordinary join handshake, which the inviter auto-approves.
 */
export const IncomingInviteDialog: React.FC = () => {
  const { incomingInvites, acceptIncomingInvite, declineIncomingInvite } = useChat();
  const [busy, setBusy] = useState<'accept' | 'decline' | null>(null);

  const invite = incomingInvites[0];
  if (!invite) return null;

  const handleAccept = async () => {
    setBusy('accept');
    try {
      await acceptIncomingInvite(invite);
    } finally {
      setBusy(null);
    }
  };

  const handleDecline = async () => {
    setBusy('decline');
    try {
      await declineIncomingInvite(invite);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open maxWidth="xs" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <MarkEmailUnreadIcon color="primary" />
        <Typography variant="h6" sx={{ fontWeight: 700 }}>
          Room Invitation
        </Typography>
      </DialogTitle>

      <DialogContent dividers>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2 }}>
          <Avatar sx={{ bgcolor: 'secondary.main', color: '#fff', fontWeight: 'bold' }}>
            {invite.inviter.screenName.charAt(0).toUpperCase()}
          </Avatar>
          <Box>
            <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
              {invite.inviter.screenName}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              wants you to join their conversation
            </Typography>
          </Box>
        </Box>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
          <Chip
            size="small"
            variant="outlined"
            color={invite.roomMode === 'public' ? 'info' : 'success'}
            icon={
              invite.roomMode === 'public' ? (
                <PublicIcon sx={{ fontSize: '14px !important' }} />
              ) : (
                <LockIcon sx={{ fontSize: '14px !important' }} />
              )
            }
            label={invite.roomMode === 'public' ? 'Public room' : 'Private room'}
          />
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }} noWrap>
            {invite.channelTitle}
          </Typography>
        </Box>

        {invite.inviter.contactInfo?.info && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
            {invite.inviter.contactInfo.info}
          </Typography>
        )}

        {incomingInvites.length > 1 && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
            {incomingInvites.length - 1} more invitation{incomingInvites.length > 2 ? 's' : ''} waiting.
          </Typography>
        )}
      </DialogContent>

      <DialogActions sx={{ px: 3, py: 1.5 }}>
        <Button onClick={handleDecline} disabled={busy !== null} color="inherit">
          {busy === 'decline' ? <CircularProgress size={16} /> : 'Decline'}
        </Button>
        <Button onClick={handleAccept} disabled={busy !== null} variant="contained">
          {busy === 'accept' ? <CircularProgress size={16} color="inherit" /> : 'Join Room'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};
