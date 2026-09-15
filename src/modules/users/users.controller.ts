import {
  Controller,
  Get,
  Patch,
  Put,
  Delete,
  HttpCode,
  HttpStatus,
  Body,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { UsersService } from './users.service';
import { UpdateProfileDto, UpdateFcmTokenDto } from './dto';
import { JwtAuthGuard } from '../auth/guards';
import { CurrentUser } from '../../common/decorators';

@ApiTags('Users')
@Controller('users')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  @ApiOperation({
    summary: 'Get current user profile',
    description:
      "Returns the authenticated user's profile including EcoPoints balance, tier, and pickup statistics.",
  })
  @ApiResponse({
    status: 200,
    description: 'User profile retrieved successfully',
    schema: {
      example: {
        success: true,
        data: {
          id: 'uuid',
          phone: '+250788123456',
          email: 'jean@example.com',
          firstName: 'Jean',
          lastName: 'Baptiste',
          userType: 'RESIDENTIAL',
          role: 'USER',
          referralCode: 'ECOJB2024',
          avatarUrl: null,
          ecoPoints: 350,
          ecoTier: 'ECO_STARTER',
          tierMultiplier: 1.0,
          totalPickups: 5,
          memberSince: '2024-01-15T10:00:00Z',
        },
      },
    },
  })
  async getProfile(@CurrentUser('id') userId: string) {
    return this.usersService.getProfile(userId);
  }

  @Patch('me')
  @ApiOperation({
    summary: 'Update current user profile',
    description:
      "Update the authenticated user's profile fields. All fields are optional — only provided fields are updated.",
  })
  @ApiResponse({
    status: 200,
    description: 'Profile updated successfully',
    schema: {
      example: {
        success: true,
        message: 'Profile updated successfully',
        data: {
          id: 'uuid',
          phone: '+250788123456',
          email: 'jean@example.com',
          firstName: 'Jean',
          lastName: 'Baptiste',
          userType: 'RESIDENTIAL',
          role: 'USER',
          referralCode: 'ECOJB2024',
          avatarUrl: null,
        },
      },
    },
  })
  @ApiResponse({ status: 409, description: 'Email already in use' })
  async updateProfile(
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.usersService.updateProfile(userId, dto);
  }

  @Get('me/referral')
  @ApiOperation({
    summary: 'Get referral code and statistics',
    description:
      "Returns the user's referral code, a shareable link, count of successful referrals, points earned from referrals, and a list of referred users.",
  })
  @ApiResponse({
    status: 200,
    description: 'Referral info retrieved successfully',
    schema: {
      example: {
        success: true,
        data: {
          referralCode: 'ECOJB2024',
          referralLink: 'https://smarteco.rw/ref/ECOJB2024',
          totalReferred: 3,
          pointsEarned: 600,
          referredUsers: [
            {
              firstName: 'Marie',
              lastName: 'Claire',
              joinedAt: '2024-03-20T14:30:00Z',
              firstPickupCompleted: true,
            },
          ],
        },
      },
    },
  })
  async getReferralInfo(@CurrentUser('id') userId: string) {
    return this.usersService.getReferralInfo(userId);
  }

  @Put('me/fcm-token')
  @ApiOperation({
    summary: 'Update FCM token',
    description:
      'Update the Firebase Cloud Messaging token for receiving push notifications. Should be called on app startup and whenever the FCM token refreshes.',
  })
  @ApiResponse({
    status: 200,
    description: 'FCM token updated successfully',
    schema: {
      example: {
        success: true,
        message: 'FCM token updated successfully',
      },
    },
  })
  async updateFcmToken(
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateFcmTokenDto,
  ) {
    return this.usersService.updateFcmToken(userId, dto);
  }

  @Delete('me')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete current user account',
    description:
      'Permanently deletes or anonymizes user account and personal data in compliance with App Store Guideline 5.1.1(v). Revokes all active sessions and tokens.',
  })
  @ApiResponse({
    status: 200,
    description: 'Account and personal data successfully deleted',
    schema: {
      example: {
        success: true,
        message: 'Your account and personal data have been successfully deleted.',
      },
    },
  })
  async deleteAccount(@CurrentUser('id') userId: string) {
    return this.usersService.deleteAccount(userId);
  }
}
