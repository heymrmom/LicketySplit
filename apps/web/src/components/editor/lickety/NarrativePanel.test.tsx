import {it,expect,afterEach} from 'vitest';import {render,screen,cleanup} from '@testing-library/react';import {NarrativePanel} from './NarrativePanel';
afterEach(cleanup);
it('cannot spend tokens without transcript, model, direction and explicit approval',()=>{render(<NarrativePanel/>);expect((screen.getByRole('button',{name:'Generate Narrative proposal'}) as HTMLButtonElement).disabled).toBe(true);expect(screen.getByLabelText(/Use AI tokens/)).toBeTruthy();});
