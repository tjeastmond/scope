import { format } from "../dates/utils";

export interface UserProfile {
  name: string;
  email: string;
  joinedAt: Date;
}

export function renderProfile(profile: UserProfile): string {
  return `${profile.name} <${profile.email}> (member since ${format(profile.joinedAt)})`;
}
