import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { DesignerToolbar } from './DesignerActions';

describe('DesignerToolbar', () => {
  it('lets authors select either RDF export profile', async () => {
    render(<DesignerToolbar />);

    const profile = screen.getByLabelText('RDF export profile');
    expect(profile).toHaveValue('playground');

    await userEvent.selectOptions(profile, 'standards');

    expect(profile).toHaveValue('standards');
  });
});
